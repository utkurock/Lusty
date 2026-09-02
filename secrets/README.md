# secrets/

Local-only material. Everything here is gitignored except this file.

## prod-ca-2021.crt

Supabase's CA certificate, used to verify the database connection's TLS instead
of switching verification off.

Get it from the Supabase dashboard: **Project Settings → Database → SSL
Configuration → Download certificate**. Save it here as `prod-ca-2021.crt`,
then uncomment `DB_SSL_CA_FILE` in `.env.local` and delete
`DB_SSL_REJECT_UNAUTHORIZED`.

On the deployment, where there is no filesystem to put it on, paste the
certificate's contents into the `DB_SSL_CA` environment variable instead — the
pool reads either one.
