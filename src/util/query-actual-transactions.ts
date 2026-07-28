import { logger } from '../logger';
import * as actualUtil from '../actual-util';
import * as fs from 'fs';

interface QueryOptions {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
}

async function queryActualTransactions(options: QueryOptions = {}) {
    const logFile = 'query-actual-transactions.log';
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // Helper function to log to both console and file
    const log = (message: string) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        logger.info(message);
        logStream.write(logMessage + '\n');
    };

    log('Starting Actual Budget transaction query...');

    try {
        // Initialize Actual Budget
        log('Initializing Actual Budget...');
        const actualProxy = await actualUtil.initializeActualProxy();

        // Get all accounts if no specific account is provided
        if (!options.accountId) {
            log('No account ID provided. Fetching all accounts...');
            const accounts = await actualProxy.getAccounts();
            log('\n=== Available Accounts ===');
            accounts.forEach((account: any) => {
                log(`ID: ${account.id}`);
                log(`Name: ${account.name}`);
                log(`Type: ${account.type || 'N/A'}`);
                log(`Closed: ${account.closed ? 'Yes' : 'No'}`);
                log('---');
            });
            logStream.end();
            return;
        }

        // Query transactions for the specified account
        log(`Querying transactions for account: ${options.accountId}`);

        const queryParams: any = {
            account: { $eq: options.accountId }
        };

        // Add date filters if provided
        if (options.startDate) {
            queryParams.date = queryParams.date || {};
            queryParams.date.$gte = options.startDate;
            log(`Start date filter: ${options.startDate}`);
        }

        if (options.endDate) {
            queryParams.date = queryParams.date || {};
            queryParams.date.$lte = options.endDate;
            log(`End date filter: ${options.endDate}`);
        }

        log(`Query parameters: ${JSON.stringify(queryParams, null, 2)}`);

        // Execute query
        const api = require('@actual-app/api');
        let query = api.q('transactions')
            .filter(queryParams)
            .select(['id', 'account', 'date', 'amount', 'payee', 'imported_payee', 'notes', 'cleared', 'category']);

        // Add limit if specified
        if (options.limit) {
            query = query.limit(options.limit);
            log(`Limiting results to ${options.limit} transactions`);
        }

        const { data: transactions } = await api.runQuery(query);

        log(`\n=== Query Results ===`);
        log(`Total transactions found: ${transactions.length}`);

        if (transactions.length > 0) {
            log('\n=== Transaction Details ===');
            transactions.forEach((transaction: any, index: number) => {
                log(`\nTransaction ${index + 1}:`);
                log(`  ID: ${transaction.id}`);
                log(`  Date: ${transaction.date}`);
                log(`  Amount: ${transaction.amount} (${(transaction.amount / 100).toFixed(2)})`);
                log(`  Payee: ${transaction.payee?.name || 'N/A'}`);
                log(`  Imported Payee: ${transaction.imported_payee || 'N/A'}`);
                log(`  Notes: ${transaction.notes || 'N/A'}`);
                log(`  Category: ${transaction.category?.name || 'N/A'}`);
                log(`  Cleared: ${transaction.cleared ? 'Yes' : 'No'}`);
            });

            // Calculate summary statistics
            const totalAmount = transactions.reduce((sum: number, t: any) => sum + t.amount, 0);
            const income = transactions.filter((t: any) => t.amount > 0).reduce((sum: number, t: any) => sum + t.amount, 0);
            const expenses = transactions.filter((t: any) => t.amount < 0).reduce((sum: number, t: any) => sum + t.amount, 0);

            log('\n=== Summary Statistics ===');
            log(`Total transactions: ${transactions.length}`);
            log(`Total amount: ${(totalAmount / 100).toFixed(2)}`);
            log(`Total income: ${(income / 100).toFixed(2)}`);
            log(`Total expenses: ${(expenses / 100).toFixed(2)}`);
            log(`Net: ${((totalAmount) / 100).toFixed(2)}`);
        }

        logStream.end();

    } catch (error) {
        log(`Fatal error during query: ${error}`);
        logStream.end();
        throw error;
    }
}

// Parse command line arguments
if (require.main === module) {
    const args = process.argv.slice(2);
    const options: QueryOptions = {};

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--account':
            case '-a':
                options.accountId = args[++i];
                break;
            case '--start-date':
            case '-s':
                options.startDate = args[++i];
                break;
            case '--end-date':
            case '-e':
                options.endDate = args[++i];
                break;
            case '--limit':
            case '-l':
                options.limit = parseInt(args[++i]);
                break;
            case '--help':
            case '-h':
                console.log(`
Usage: node dist/query-actual-transactions.js [options]

Options:
  -a, --account <id>        Account ID to query (if not provided, lists all accounts)
  -s, --start-date <date>   Start date filter (YYYY-MM-DD)
  -e, --end-date <date>     End date filter (YYYY-MM-DD)
  -l, --limit <number>      Limit number of results
  -h, --help                Show this help message

Examples:
  # List all accounts
  node dist/query-actual-transactions.js

  # Query all transactions for an account
  node dist/query-actual-transactions.js -a <actual-account-id>

  # Query transactions for a date range
  node dist/query-actual-transactions.js -a <actual-account-id> -s 2025-12-01 -e 2025-12-12

  # Query with limit
  node dist/query-actual-transactions.js -a <actual-account-id> -l 10
                `);
                process.exit(0);
        }
    }

    queryActualTransactions(options)
        .then(() => {
            logger.info('Query completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Query failed:', error);
            process.exit(1);
        });
}

export { queryActualTransactions };
