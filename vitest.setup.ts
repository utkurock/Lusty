import { StrKey } from '@stellar/stellar-sdk'

// The registry gates an underlying on having somewhere to settle, so a test
// runner with no vault address configured has no tradeable asset at all — and
// every test about quoting, booking or settling XLM would be testing the gate
// instead of the thing it names.
//
// So: a synthetic address, valid strkey, naming nothing deployed. Tests that
// are about the gating itself set their own env and re-import the registry.
process.env.NEXT_PUBLIC_VAULT_CONTRACT ??= StrKey.encodeContract(
  Buffer.alloc(32, 0x11),
)
