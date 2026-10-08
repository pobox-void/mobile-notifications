
import { expand } from 'dotenv-expand';
import { logger } from './logger';
import * as dotenv from 'dotenv';
const api = require('@actual-app/api')

const config = dotenv.config({ path: './env/.env' });
expand(config);
expand(dotenv.config());

export async function initializeActualProxy() {

    const initActual = async () => {
        await api.init({
            // Budget data will be cached locally here, in subdirectories for each file.
            dataDir: process.env.ACTUAL_DATA_DIR || './user-files',
            // This is the URL of your running server
            serverURL: 'http://localhost:5006',
            // This is the password you use to log into the server
            password: process.env.ACTUAL_PASSWORD
        });
        await api.downloadBudget(process.env.ACTUAL_BUDGET_ID);
    };

    try {
        await initActual();
    } catch (e: any) {
        if (e.reason === 'out-of-sync' || e.type === 'SyncError' || (e.message && (e.message.includes('out-of-sync') || e.message.includes('SyncError'))) || (e.stack && e.stack.includes('handlers.api/download-budget'))) {
            logger.warn("SyncError detected. Exiting with code 42 to trigger external recovery...");
            process.exit(42);
        } else {
            logger.error("Failed to initialize Actual API. Error details:", JSON.stringify(e, Object.getOwnPropertyNames(e)));
            throw e;
        }
    }

    /**
     * @deprecated Legacy bank utilities. Use newer reconciled models.
     */
    function normalizeAmount(amt: string) {
        const posDecimalPoint = amt.indexOf('.')
        if (posDecimalPoint < 0) {
            return Number(amt + '00')
        }
        const decimalDigits = amt.substring(posDecimalPoint + 1)
        if (decimalDigits.length === 1) {
            return Number(amt.substring(0, posDecimalPoint) + decimalDigits + '0')
        } else if (decimalDigits.length === 2) {
            return Number(amt.substring(0, posDecimalPoint) + decimalDigits)
        }
        throw Error(`Invalid number ${amt}`)
    }

    async function importTransactions(account, transactions) {
        try {
            const result = await api.importTransactions(account, transactions)
            return result
        } catch (e: any) {
            if (e.code === 'SQLITE_READONLY_DBMOVED') {
                logger.warn("SQLITE_READONLY_DBMOVED detected. Re-initializing Actual API and retrying...");
                try {
                    await initActual();
                    logger.info("Re-initialization successful. Retrying import...");
                    const result = await api.importTransactions(account, transactions);
                    return result;
                } catch (retryError) {
                    logger.error("Failed to import transactions after retry:", retryError);
                    throw retryError;
                }
            } else {
                throw e;
            }
        }
    }

    async function deleteTransaction(id) {
        try {
            const result = await api.deleteTransaction(id)
            return result
        } catch (e: any) {
            if (e.code === 'SQLITE_READONLY_DBMOVED') {
                logger.warn("SQLITE_READONLY_DBMOVED detected. Re-initializing Actual API and retrying...");
                try {
                    await initActual();
                    logger.info("Re-initialization successful. Retrying delete...");
                    const result = await api.deleteTransaction(id);
                    return result;
                } catch (retryError) {
                    logger.error("Failed to delete transaction after retry:", retryError);
                    throw retryError;
                }
            } else {
                throw e;
            }
        }
    }

    async function getAccounts() {
        const accounts = await api.getAccounts()
        return accounts
    }

    async function getCategoryGroups() {
        const categoryGroups = await api.getCategoryGroups()
        return categoryGroups
    }

    async function getCategories() {
        const categories = await api.getCategories()
        return categories
    }
    async function syncChanges() {
        logger.info('Syncing changes to Actual Budget server...');
        await api.sync();
        logger.info('Sync completed successfully');
    }

    async function getTransactionsForAccount(accountId: string, startDate: string, endDate: string) {
        const transactions = await api.getTransactions(accountId, startDate, endDate);
        return transactions;
    }

    async function getAccountBalance(accountId: string) {
        const balance = await api.getAccountBalance(accountId);
        return balance;
    }
    async function shutdown() {
        await api.shutdown();
    }

    return { normalizeAmount, getCategories, getCategoryGroups, getAccounts, importTransactions, deleteTransaction, syncChanges, getTransactionsForAccount, getAccountBalance, shutdown }
}

if (require.main === module) {
    logger.info('called directly');
    (async function run() {
        const actualProxy = await initializeActualProxy()
        logger.info(JSON.stringify(await actualProxy.getAccounts(), null, 4))
        await actualProxy.shutdown()
        logger.info('Done!')
    })()
}
