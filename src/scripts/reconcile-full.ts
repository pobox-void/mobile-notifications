import { logger } from '../logger';
import { UP_BANK_ACCOUNT_MAP } from '../account-maps';
import * as actualUtil from '../actual-util';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

const config = dotenv.config({ path: './env/.env' });
expand(config);

process.on('unhandledRejection', (reason, p) => {
    logger.error('Unhandled Rejection at:', p, 'reason:', reason);
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
    const since = startDate.toISOString();

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

async function reconcileFull() {
    const logFile = 'logs/reconcile-full.log';
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const log = (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        logger.info(message);
        logStream.write(logMessage + '\n');
    };

    log('Starting FULL Up Bank Reconciliation (Ignoring date window)...');

    let actualProxy: any = null;

    try {
        actualProxy = await actualUtil.initializeActualProxy();

        // ABSOLUTE HISTORICAL RANGE: From the beginning
        const startDate = '2000-01-01';
        const now = new Date();
        const endDate = now.toISOString().split('T')[0];

        log(`Absolute Reconciliation Period: From ${startDate} to ${endDate}`);

        for (const [upAccountId, actualAccountId] of Object.entries(UP_BANK_ACCOUNT_MAP)) {
            log(`\n---------------------------------------------------`);
            log(`Reconciling Account: Up ID ${upAccountId} -> Actual ID ${actualAccountId}`);

            // 1. Fetch Up Data
            log('Fetching ALL data from Up Bank...');
            const upTransactions = await fetchUpTransactions(upAccountId, new Date(startDate));
            const upBalance = await fetchUpAccountBalance(upAccountId);

            log(`Up Bank: ${upTransactions.length} transactions found.`);
            log(`Up Bank Balance: ${(upBalance / 100).toFixed(2)}`);

            // 2. Fetch Actual Data
            log('Fetching ALL data from Actual Budget...');
            const actualTransactions = await actualProxy.getTransactionsForAccount(actualAccountId, startDate, endDate);
            const actualBalance = await actualProxy.getAccountBalance(actualAccountId);

            log(`Actual Budget: ${actualTransactions.length} transactions found.`);
            log(`Actual Budget Balance: ${(actualBalance / 100).toFixed(2)}`);

            // Dump full Up Bank payload to JSON
            const jsonFilename = 'logs/reconcile-full-upbank-all-transactions.json';
            fs.writeFileSync(jsonFilename, JSON.stringify(upTransactions, null, 2));
            log(`Full Up Bank transaction payload written to: ${jsonFilename}`);

            // 3. Compare Transactions
            const upTransactionMap = new Map(upTransactions.map(t => [t.id, t]));
            // Actual transactions map by imported_id
            const actualImportedMap = new Map();
            const manualActualTransactions: any[] = [];
            const amountMismatches: any[] = [];

            for (const actualTran of actualTransactions) {
                if (actualTran.imported_id) {
                    actualImportedMap.set(actualTran.imported_id, actualTran);
                } else {
                    manualActualTransactions.push(actualTran);
                }
            }

            const missingInActual: UpTransaction[] = [];
            const missingInUp: any[] = [];

            // Check what's in Up but not in Actual
            for (const upTran of upTransactions) {
                const actualTran = actualImportedMap.get(upTran.id);
                if (!actualTran) {
                    missingInActual.push(upTran);
                } else {
                    // Check if amounts match
                    if (actualTran.amount !== upTran.attributes.amount.valueInBaseUnits) {
                        amountMismatches.push({
                            up: upTran,
                            actual: actualTran
                        });
                    }
                }
            }

            // Check what's in Actual (with ID) but not in Up
            for (const [id, actualTran] of actualImportedMap.entries()) {
                if (!upTransactionMap.has(id)) {
                    missingInUp.push(actualTran);
                }
            }

            // 4. Report Discrepancies
            if (missingInActual.length === 0 && missingInUp.length === 0 && amountMismatches.length === 0 && manualActualTransactions.length === 0) {
                log('✅ All Transactions and Amounts Match!');
            } else {
                log('❌ Historical Discrepancies Found.');

                if (missingInActual.length > 0) {
                    log(`Found ${missingInActual.length} transactions in Up that are MISSING in Actual:`);
                    missingInActual.forEach(t => {
                        log(`  [MISSING] ${t.attributes.createdAt.split('T')[0]} ${t.attributes.description} (${t.attributes.amount.valueInBaseUnits}) [ID: ${t.id}]`);
                    });
                }

                if (missingInUp.length > 0) {
                    log(`Found ${missingInUp.length} transactions in Actual that are MISSING in Up (unexpected):`);
                    missingInUp.forEach(t => {
                        log(`  [UNEXPECTED] ${t.date} ${t.payee_name || t.imported_payee} (${t.amount}) [ID: ${t.imported_id}]`);
                    });
                }

                if (amountMismatches.length > 0) {
                    log(`Found ${amountMismatches.length} transactions where AMOUNTS DO NOT MATCH:`);
                    amountMismatches.forEach(m => {
                        log(`  [AMOUNT MISMATCH] ${m.actual.date} ${m.actual.payee_name || m.actual.imported_payee}`);
                        log(`    Up:     ${m.up.attributes.amount.valueInBaseUnits}`);
                        log(`    Actual: ${m.actual.amount}`);
                        log(`    Diff:   ${m.actual.amount - m.up.attributes.amount.valueInBaseUnits}`);
                    });
                }

                if (manualActualTransactions.length > 0) {
                    log(`Found ${manualActualTransactions.length} MANUAL transactions in Actual Budget (no imported_id):`);
                    manualActualTransactions.forEach(t => {
                        log(`  [MANUAL] ${t.date} ${t.payee_name || t.imported_payee} (${t.amount})`);
                    });
                }
            }

            // 5. Implied Starting Balance Calculation
            const upSum = upTransactions.reduce((sum, t) => sum + t.attributes.amount.valueInBaseUnits, 0);
            const actualSum = actualTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);

            const impliedUpStart = upBalance - upSum;
            const impliedActualStart = actualBalance - actualSum;

            // 6. Running Balance Comparison
            log('\n--- Running Balance Analysis ---');
            const sortedUp = [...upTransactions].sort((a, b) => a.attributes.createdAt.localeCompare(b.attributes.createdAt));

            let runningUp = 0;
            let runningActual = 0;
            let firstDivergence: any = null;
            const runningBalanceLines: string[] = [];

            // Header
            runningBalanceLines.push(`${'#'.padStart(4)} | ${'Date'.padEnd(26)} | ${'Description'.padEnd(30)} | ${'Amount'.padStart(10)} | ${'Up Running'.padStart(12)} | ${'Actual Running'.padStart(14)} | ${'Gap'.padStart(8)}`);
            runningBalanceLines.push('-'.repeat(120));

            for (let i = 0; i < sortedUp.length; i++) {
                const upT = sortedUp[i];
                const actualT = actualImportedMap.get(upT.id);

                runningUp += upT.attributes.amount.valueInBaseUnits;
                if (actualT) {
                    runningActual += actualT.amount;
                }

                const gap = runningActual - runningUp;
                const line = `${String(i + 1).padStart(4)} | ${upT.attributes.createdAt.padEnd(26)} | ${upT.attributes.description.substring(0, 30).padEnd(30)} | ${(upT.attributes.amount.valueInBaseUnits / 100).toFixed(2).padStart(10)} | ${(runningUp / 100).toFixed(2).padStart(12)} | ${(runningActual / 100).toFixed(2).padStart(14)} | ${(gap / 100).toFixed(2).padStart(8)}`;
                runningBalanceLines.push(line);

                if (!firstDivergence && Math.abs(gap) > 1) {
                    firstDivergence = {
                        index: i,
                        date: upT.attributes.createdAt,
                        upDesc: upT.attributes.description,
                        upAmt: upT.attributes.amount.valueInBaseUnits,
                        actualAmt: actualT ? actualT.amount : 'MISSING',
                        diff: gap
                    };
                }
            }

            // Write running balance file
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const rbFilename = `logs/reconcile-full-with-running-balances-${ts}.log`;
            fs.writeFileSync(rbFilename, runningBalanceLines.join('\n') + '\n');
            log(`Running balance report written to: ${rbFilename}`);

            if (firstDivergence) {
                log(`❌ FIRST DIVERGENCE detected at transaction #${firstDivergence.index + 1}:`);
                log(`  Date: ${firstDivergence.date}`);
                log(`  Desc: ${firstDivergence.upDesc}`);
                log(`  Up Amt: ${firstDivergence.upAmt}, Actual Amt: ${firstDivergence.actualAmt}`);
                log(`  Running Gap at this point: ${(firstDivergence.diff / 100).toFixed(2)}`);
            } else {
                log(`✅ Running balances remained perfectly aligned through all ${sortedUp.length} transactions.`);
            }


            // 6. Balance Check & Implied Starting Balance
            const diff = impliedActualStart - impliedUpStart;
            log(`\n--- Final Balance Audit ---`);
            log(`Total History Discrepancy (Implied Start): ${(diff / 100).toFixed(2)}`);

            if (Math.abs(diff) < 1) {
                log(`✅ Historical sums match the reported balances.`);
            } else {
                log(`❌ UNRESOLVED GAP: ${(diff / 100).toFixed(2)}`);
                log(`This gap points to a mismatch in transactions BEFORE ${startDate} or a manual balance adjustment.`);
            }

            // 6. Check for HELD transactions
            const heldTransactions = upTransactions.filter(t => (t as any).attributes.status === 'HELD');
            if (heldTransactions.length > 0) {
                log(`\n⚠️ Found ${heldTransactions.length} PENDING (HELD) transactions in Up Bank:`);
                heldTransactions.forEach(t => {
                    log(`  - ${t.attributes.createdAt.split('T')[0]} ${t.attributes.description} (${t.attributes.amount.valueInBaseUnits})`);
                });
                log(`Note: Pending transactions may cause temporary discrepancies.`);
            } else {
                log(`\n✅ No PENDING (HELD) transactions found in fetched Up list.`);
            }
        }

    } catch (error) {
        log(`Fatal Error during full reconciliation: ${error}`);
        if (error instanceof Error) log(error.stack || '');
    } finally {
        try {
            if (actualProxy) {
                await actualProxy.shutdown();
                log('Actual Shutdown executed.');
            }
        } catch (shutdownError) {
            log(`Error during shutdown: ${shutdownError}`);
        }
        log('Full Reconciliation Ended.');
        logStream.end();
    }
}

reconcileFull();
