-- 0001 · baseline
-- The first migration. pgcrypto gives later tickets digest() for the audit
-- hash chain (M1-07) and the peppered PIN hash (M1-23). Nothing else yet:
-- tenancy tables arrive with M1-05.
set lock_timeout = '5s';

create extension if not exists pgcrypto;
