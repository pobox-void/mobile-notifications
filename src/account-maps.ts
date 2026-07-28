
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

const config = dotenv.config({ path: './env/.env' });
expand(config);

export const UP_BANK_ACCOUNT_MAP = {
    [process.env.UP_BANK_TRANSACTION_ACCOUNT_ID]: process.env.ACTUAL_UP_BANK_TRANSACTION_ACCOUNT_ID
};
