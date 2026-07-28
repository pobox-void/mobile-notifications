import { logger } from '../logger';
import { UP_BANK_ACCOUNT_MAP } from '../account-maps';
import * as actualUtil from '../actual-util';
import * as fs from 'fs';

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

interface ImportStats {
    total: number;
    added: number;
    updated: number;
    updatedPreview: number;
    errors: number;
    errorDetails: Array<{ transaction: string; error: string }>;
}

async function fetchAllUpTransactions(): Promise<UpTransaction[]> {
    const transactions: UpTransaction[] = [];
    let nextUrl: string | null = 'https://api.up.com.au/api/v1/transactions?page[size]=100';

    while (nextUrl) {
        const response = await fetch(nextUrl, {
            headers: {
                'Authorization': `Bearer ${process.env.UPBANK_APIKEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch transactions: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        transactions.push(...data.data);

        // Check if there's a next page
        nextUrl = data.links?.next || null;

        logger.info(`Fetched ${data.data.length} transactions. Total so far: ${transactions.length}`);
    }

    return transactions;
}

async function importUpTransactions() {
    const logFile = 'import-up-transactions.log';
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // Helper function to log to both console and file
    const log = (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        logger.info(message);
        logStream.write(logMessage + '\n');
    };

    log('Starting Up Bank transaction import...');

    const stats: ImportStats = {
        total: 0,
        added: 0,
        updated: 0,
        updatedPreview: 0,
        errors: 0,
        errorDetails: []
    };

    try {
        // Initialize Actual Budget
        log('Initializing Actual Budget...');
        const actualProxy = await actualUtil.initializeActualProxy();

        // Fetch all transactions from Up Bank
        log('Fetching transactions from Up Bank...');
        const upTransactions = await fetchAllUpTransactions();
        stats.total = upTransactions.length;
        log(`Fetched ${stats.total} transactions from Up Bank`);

        // Group transactions by account
        const transactionsByAccount = new Map<string, any[]>();

        for (const upTransaction of upTransactions) {
            // Skip transactions that don't have the expected structure
            if (!upTransaction.relationships?.account?.data?.id) {
                log(`\n=== SKIPPED TRANSACTION (Missing Account Relationship) ===`);
                log(`Transaction ID: ${upTransaction.id || 'unknown'}`);
                log(`Full structure:\n${JSON.stringify(upTransaction, null, 2)}`);
                log(`=== END SKIPPED TRANSACTION ===\n`);

                stats.errors++;
                stats.errorDetails.push({
                    transaction: upTransaction.id || 'unknown',
                    error: 'Missing account relationship (possibly a transfer or settlement)'
                });
                continue;
            }

            const upAccountId = upTransaction.relationships.account.data.id;
            const actualAccountId = UP_BANK_ACCOUNT_MAP[upAccountId];

            if (!actualAccountId) {
                log(`No mapping found for Up Account ID: ${upAccountId}. Skipping transaction ${upTransaction.id}`);
                stats.errors++;
                stats.errorDetails.push({
                    transaction: upTransaction.id,
                    error: `No account mapping for ${upAccountId}`
                });
                continue;
            }

            const attributes = upTransaction.attributes;
            const transaction = {
                account: actualAccountId,
                amount: attributes.amount.valueInBaseUnits,
                date: attributes.createdAt.split('T')[0], // YYYY-MM-DD
                payee_name: attributes.description,
                imported_payee: attributes.rawText,
                notes: attributes.message,
                imported_id: upTransaction.id,
                cleared: true
            };

            if (!transactionsByAccount.has(actualAccountId)) {
                transactionsByAccount.set(actualAccountId, []);
            }
            transactionsByAccount.get(actualAccountId)!.push(transaction);
        }

        // Import transactions for each account
        for (const [actualAccountId, transactions] of Array.from(transactionsByAccount.entries())) {
            log(`Importing ${transactions.length} transactions for account ${actualAccountId}...`);

            try {
                const result = await actualProxy.importTransactions(actualAccountId, transactions);

                if (result) {
                    const added = result.added?.length || 0;
                    const updated = result.updated?.length || 0;
                    const updatedPreview = result.updatedPreview?.length || 0;

                    stats.added += added;
                    stats.updated += updated;
                    stats.updatedPreview += updatedPreview;

                    log(`Account ${actualAccountId}: ${added} added, ${updated} updated, ${updatedPreview} updated preview`);

                    if (result.errors && result.errors.length > 0) {
                        stats.errors += result.errors.length;
                        result.errors.forEach((error: any) => {
                            stats.errorDetails.push({
                                transaction: error.transaction || 'unknown',
                                error: error.message || JSON.stringify(error)
                            });
                        });
                    }
                } else {
                    log(`No result returned for account ${actualAccountId}`);
                }
            } catch (error) {
                log(`Error importing transactions for account ${actualAccountId}: ${error}`);
                stats.errors += transactions.length;
                stats.errorDetails.push({
                    transaction: `Account ${actualAccountId}`,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        // Sync changes to ensure they appear in the browser UI
        log('\nSyncing changes to server...');
        await actualProxy.syncChanges();

        // Print summary
        log('\n=== Import Summary ===');
        log(`Total transactions fetched: ${stats.total}`);
        log(`Successfully added: ${stats.added}`);
        log(`Successfully updated: ${stats.updated}`);
        log(`Updated (preview): ${stats.updatedPreview}`);
        log(`Errors: ${stats.errors}`);

        if (stats.errorDetails.length > 0) {
            log('\n=== Error Details ===');
            stats.errorDetails.forEach(detail => {
                log(`Transaction ${detail.transaction}: ${detail.error}`);
            });
        }

        logStream.end();

    } catch (error) {
        log(`Fatal error during import: ${error}`);
        logStream.end();
        throw error;
    }
}

// Run the import if this file is executed directly
if (require.main === module) {
    importUpTransactions()
        .then(() => {
            logger.info('Import completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Import failed:', error);
            process.exit(1);
        });
}

export { importUpTransactions };
