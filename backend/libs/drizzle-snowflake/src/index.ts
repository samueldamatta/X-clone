import { customType } from 'drizzle-orm/pg-core';

/**
 * The one place every NestJS service declares a Snowflake column. `pg`
 * returns `bigint` (Postgres OID 20) as a JavaScript string by default,
 * specifically to avoid the precision loss above `Number.MAX_SAFE_INTEGER`
 * — this type passes that through rather than converting anything, so a
 * Snowflake id is a string from the driver to the JSON response with no
 * serialisation layer to forget.
 *
 * Verified against drizzle-orm 0.45.2 / drizzle-kit 0.31.10 / pg 8.23.0 in
 * the spike behind docs/adr/0006-drizzle-as-the-orm.md: partial indexes on
 * a column of this type generate and query correctly, and a 19-digit id
 * round-trips digit for digit.
 */
export const snowflake = customType<{ data: string; driverData: string }>({
  dataType: () => 'bigint',
});
