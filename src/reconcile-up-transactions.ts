import { logger } from './logger';
import { UP_BANK_ACCOUNT_MAP } from './account-maps';
import * as actualUtil from './actual-util';
import { sendEmail } from './email';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

const config = dotenv.config({ path: './env/.env' });
expand(config);

process.on('unhandledRejection', (reason, p) => {
    logger.error('Unhandled Rejection at:', p, 'reason:', reason);
    // Prevent crash by not exiting, but log it.
});

interface UpTransaction {
    type: string;
    id: string;
    attributes: {
        description: string;
        rawText: string;
        message: string | null;
        amount: {
            valueInBaseUnits: number;
        };
        createdAt: string;
    };
    relationships: {
        account: {
            data: {
                type: string;
                id: string;
            };
        };
    };
}

async function fetchUpTransactions(accountId: string, startDate: Date): Promise<UpTransaction[]> {
    const transactions: UpTransaction[] = [];
    // Subtract 2 days to create a wide timezone buffer. 
    // We will filter these down to the exact local calendar days later.
    const bufferDate = new Date(startDate);
    bufferDate.setDate(bufferDate.getDate() - 2);
    bufferDate.setHours(0, 0, 0, 0);
    const since = bufferDate.toISOString();

    let nextUrl: string | null = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions?filter[since]=${since}&page[size]=100`;

    while (nextUrl) {
        const response = await fetch(nextUrl, {
            headers: {
                'Authorization': `Bearer ${process.env.UPBANK_APIKEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Up transactions: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        transactions.push(...data.data);
        nextUrl = data.links?.next || null;
    }

    return transactions;
}

async function fetchUpAccountBalance(accountId: string): Promise<number> {
    const url = `https://api.up.com.au/api/v1/accounts/${accountId}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${process.env.UPBANK_APIKEY}`
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Up account balance: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.data.attributes.balance.valueInBaseUnits;
}

async function reconcile() {
    const logFile = 'reconcile-up-transactions.log';
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const emailLines: string[] = [];

    const log = (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        logger.info(message);
        logStream.write(logMessage + '\n');
    };

    const emailLog = (message: string) => {
        emailLines.push(message);
    };

    log('Starting Up Bank Reconciliation...');
    emailLog('Starting Up Bank Reconciliation...');

    let actualProxy: any = null;

    try {
        actualProxy = await actualUtil.initializeActualProxy();

        // Calculate date range: Last month start to today
        const now = new Date();
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        // Format as YYYY-MM-DD for Actual
        const startDate = startOfLastMonth.toISOString().split('T')[0];
        const endDate = now.toISOString().split('T')[0];

        log(`Reconciliation Period: ${startDate} to ${endDate}`);
        emailLog(`Reconciliation Period: ${startDate} to ${endDate}`);

        for (const [upAccountId, actualAccountId] of Object.entries(UP_BANK_ACCOUNT_MAP)) {
            log(`\n---------------------------------------------------`);
            log(`Reconciling Account: Up ID ${upAccountId} -> Actual ID ${actualAccountId}`);
            emailLog(`\n---------------------------------------------------`);
            emailLog(`Reconciling Account: Up ID ${upAccountId} -> Actual ID ${actualAccountId}`);

            // 1. Fetch Up Data
            log('Fetching data from Up Bank...');
            const allUpTransactions = await fetchUpTransactions(upAccountId, startOfLastMonth);

            // Filter Up transactions to only include those that match the Actual Budget date range (local time)
            const upTransactions = allUpTransactions.filter(t => {
                const localDate = t.attributes.createdAt.split('T')[0];
                return localDate >= startDate && localDate <= endDate;
            });

            const upBalance = await fetchUpAccountBalance(upAccountId);
            log(`Up Bank: ${upTransactions.length} transactions found (Filtered from ${allUpTransactions.length} fetched).`);
            log(`Up Bank Balance: ${(upBalance / 100).toFixed(2)}`);

            // 2. Fetch Actual Data
            log('Fetching data from Actual Budget...');
            const actualTransactions = await actualProxy.getTransactionsForAccount(actualAccountId, startDate, endDate);
            const actualBalance = await actualProxy.getAccountBalance(actualAccountId);

            log(`Actual Budget: ${actualTransactions.length} transactions found.`);
            log(`Actual Budget Balance: ${(actualBalance / 100).toFixed(2)}`);

            emailLog(`Up Bank Balance: ${(upBalance / 100).toFixed(2)}`);
            emailLog(`Actual Budget Balance: ${(actualBalance / 100).toFixed(2)}`);

            // 3. Compare Transactions
            const upTransactionMap = new Map(upTransactions.map(t => [t.id, t]));
            const actualTransactionMap = new Map(actualTransactions.map((t: any) => [t.imported_id, t]));

            const missingInActual: UpTransaction[] = [];
            const missingInUp: any[] = [];

            // Find missing in Actual
            for (const upTran of upTransactions) {
                if (!actualTransactionMap.has(upTran.id)) {
                    missingInActual.push(upTran);
                }
            }

            // Find missing in Up (only if it has an imported_id, i.e., it was imported from Up)
            for (const actualTran of actualTransactions) {
                if (actualTran.imported_id && !upTransactionMap.has(actualTran.imported_id)) {
                    // Check if it looks like an Up transaction (imported_id starts with UUID-like or just check logic)
                    // Up IDs are UUIDs.
                    missingInUp.push(actualTran);
                }
            }

            // 4. Report
            if (missingInActual.length === 0 && missingInUp.length === 0) {
                log('✅ Transactions Match!');
                emailLog('✅ Transactions Match!');
            } else {
                log('❌ Transactions DO NOT Match.');
                emailLog('❌ Transactions DO NOT Match.');

                if (missingInActual.length > 0) {
                    const missingMsg = `Found ${missingInActual.length} transactions in Up that are MISSING in Actual:`;
                    log(missingMsg);
                    emailLog(missingMsg);
                    missingInActual.forEach(t => {
                        const tMsg = `  - ${t.attributes.createdAt.split('T')[0]} ${t.attributes.description} (${t.attributes.amount.valueInBaseUnits}) [ID: ${t.id}]`;
                        log(tMsg);
                        emailLog(tMsg);
                    });

                    // 5. Fix: Import missing transactions
                    log('Importing missing transactions into Actual...');
                    const transactionsToImport = missingInActual.map(upTran => ({
                        account: actualAccountId,
                        amount: upTran.attributes.amount.valueInBaseUnits,
                        date: upTran.attributes.createdAt.split('T')[0],
                        payee_name: upTran.attributes.description,
                        imported_payee: upTran.attributes.rawText,
                        notes: upTran.attributes.message,
                        imported_id: upTran.id,
                        cleared: true,
                        forceAddTransaction: true
                    }));

                    try {
                        const result = await actualProxy.importTransactions(actualAccountId, transactionsToImport);
                        log(`Import Result: ${JSON.stringify(result)}`);
                    } catch (err) {
                        log(`Error importing transactions: ${err}`);
                    }
                }

                if (missingInUp.length > 0) {
                    const missingUpMsg = `Found ${missingInUp.length} transactions in Actual that are MISSING in Up (and have imported_id):`;
                    log(missingUpMsg);
                    emailLog(missingUpMsg);
                    missingInUp.forEach(t => {
                        const tMsg = `  - ${t.date} ${t.payee_name || t.imported_payee} (${t.amount}) [ID: ${t.imported_id}]`;
                        log(tMsg);
                        emailLog(tMsg);
                    });
                    log('  (These might be deleted in Up or manually added with a fake ID in Actual)');
                }
            }

            // 6. Balance Reconciliation
            // Re-fetch Actual Balance to account for any imports
            const finalActualBalance = await actualProxy.getAccountBalance(actualAccountId);
            const diff = finalActualBalance - upBalance;

            // Calculate explained difference based on transactions known to be in Actual but not Up
            // (transactions missing in Actual were just imported, so they should be in both now)
            const explainedDiff = missingInUp.reduce((sum, t) => sum + t.amount, 0);

            log(`\n--- Balance Reconciliation ---`);
            log(`Up Bank Balance: ${(upBalance / 100).toFixed(2)}`);
            log(`Actual Budget Balance: ${(finalActualBalance / 100).toFixed(2)}`);
            log(`Difference: ${(diff / 100).toFixed(2)}`);
            log(`Sum of Transactions in Actual but not Up: ${(explainedDiff / 100).toFixed(2)}`);

            emailLog(`\n--- Balance Reconciliation ---`);
            emailLog(`Difference: ${(diff / 100).toFixed(2)}`);
            emailLog(`Explained Difference: ${(explainedDiff / 100).toFixed(2)}`);

            if (Math.abs(diff - explainedDiff) < 1) {
                const msg = `✅ Difference is explained by the ${missingInUp.length} transactions missing in Up.`;
                log(msg);
                emailLog(msg);
            } else {
                const msg = `❌ Difference is NOT fully explained. Unexplained difference: ${((diff - explainedDiff) / 100).toFixed(2)}`;
                log(msg);
                emailLog(msg);
                log(`Note: Discrepancies outside the checked date range (${startDate} to ${endDate}) may cause unexplained differences.`);
            }
        }

        log('\nSyncing changes to Actual Budget...');
        await actualProxy.syncChanges();
        log('Reconciliation Complete.');
        emailLog('\nReconciliation Complete.');

        // Send Email
        try {
            log('Sending reconciliation summary email...');
            await sendEmail(emailLines.join('\n'));
        } catch (emailError) {
            log(`Failed to send summary email: ${emailError}`);
        }

    } catch (error) {
        log(`Fatal Error: ${error}`);
    } finally {
        try {
            if (actualProxy) {
                await actualProxy.shutdown();
                log('Actual Shutdown executed.')
            }
        } catch (shutdownError) {
            log(`Error during shutdown: ${shutdownError}`);
        }
        logStream.end();
    }
}

reconcile();
