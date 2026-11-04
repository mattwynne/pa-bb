// Independent fixture byte digest. No acceptance, exposure or execution accounting.
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(value).digest('hex');
