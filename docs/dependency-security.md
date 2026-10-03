# Dependency security review

Recorded so the decision is auditable rather than assumed. Re-check with `npm audit` and
`npm run mpp:audit` after any dependency change.

## Runtime dependency advisories

`npm audit` reports three runtime findings. Two are reachable in principle and are fixed;
one is proven unreachable.

### 1. axios — FIXED via override

`@stellar/stellar-sdk@15.1.0` pins `axios: 1.15.0` exactly. That version is affected by ~30
advisories, several high severity, including several directly relevant to a payment gateway
that makes outbound HTTPS calls:

| Advisory | CVSS | Why it matters here |
|---|---|---|
| GHSA-35jp-ww65-95wh | 8.7 | Full man-in-the-middle via prototype-pollution gadget in `config.proxy` |
| GHSA-pjwm-pj3p-43mv | 8.6 | `shouldBypassProxy` misses IPv4-mapped IPv6, allowing `NO_PROXY` bypass (SSRF) |
| GHSA-6chq-wfr3-2hj9 | 7.4 | Header injection via prototype pollution |
| GHSA-pf86-5x62-jrwf | 7.4 | Response tampering / request hijacking via prototype pollution |
| GHSA-62hf-57xw-28j9 | 7.5 | Unbounded recursion DoS in `toFormData` |
| GHSA-hfxv-24rg-xrqf | 7.5 | ReDoS via cookie-name injection |
| GHSA-j5f8-grm9-p9fc | 7.5 | `Proxy-Authorization` credential leak across HTTP→HTTPS redirect |
| GHSA-m7pr-hjqh-92cm | 6.8 | `no_proxy` bypass via IP alias allows SSRF |

Every one of these ranges ends at `<1.20.0`. stellar-sdk 15.1.0 and 16.3.0 both pin a vulnerable
axios (1.15.0 and 1.18.0 respectively), so **upgrading the Stellar SDK does not fix this**.

PageSure forces the fix with an npm `override`:

```jsonc
"overrides": { "axios": "1.20.0" }
```

This is a patch-level bump within axios 1.x, so it is semver-compatible with stellar-sdk's
requirement. Verified: `npm ls axios` reports `axios@1.20.0 overridden`, all axios advisories
clear, and a live Horizon + Soroban RPC call against testnet succeeds through the overridden
adapter.

### 2. mppx 0.6.31 — NOT REACHABLE, proven

| Advisory | CVSS | Patched |
|---|---|---|
| GHSA-vc9j-9wph-qghj (CVE-2026-63628) "Gas Draining with access list" | Moderate | 0.8.2 |
| GHSA-727h-3vm5-qwq6 (CVE-2026-63627) "Gas Draining with padding" | Moderate | 0.8.1 |

Both are **EVM-only**. Both require:

- `mppx`'s `FeePayerPolicy` in `mppx/dist/tempo/**` — the **Tempo** (EVM chain) method
- an EIP-2930 `access_list`, or legacy calldata gas pricing (16 gas per non-zero byte)
- `viem`'s `decodeFunctionData`, which is lenient about trailing bytes
- an EVM `transferWithMemo` call

PageSure uses `method: 'stellar'`: Soroban `invokeHostFunction` transactions against SEP-41 SAC
contracts. Stellar transactions have **no** EIP-2930 access list, **no** `transferWithMemo`,
**no** legacy calldata pricing, and the Stellar method never calls viem ABI decoding.

Proven mechanically, not asserted: `npm run mpp:audit` walks every `.js` file in
`node_modules/@stellar/mpp/dist` and fails if any file references `access_list`, `accessList`,
`decodeFunctionData`, or `viem`. Result: **0 files**. The vulnerable code is present in
`node_modules/mppx/dist/tempo/` and is simply never imported by the Stellar method.

**Why not upgrade anyway.** `mppx >= 0.8.2` does not satisfy `@stellar/mpp@0.7.1`'s peer range
`^0.6.29`, so taking the fix means moving to unreleased `@stellar/mpp` `main`, which peers
`mppx ^0.10.1` and whose own published examples do not run against it. Trading a proven-unreachable
advisory for an unreleased moving target in a payment path is the worse trade. If PageSure ever
adds an EVM method, this decision must be revisited immediately.

**Compensating controls** (defence in depth, independent of reachability analysis):
- `maxFeeBumpStroops` is set explicitly rather than left at default.
- A per-wallet rate limit is enforced *before* any challenge is issued.
- A `feeBudget` is configured on the channel server.

### 3. toml 3.0.0 (via stellar-sdk 15.1.0) — NOT REACHABLE

| Advisory | Severity |
|---|---|
| GHSA-82x6-q7mm-w9cf "Uncontrolled Recursion" | High |
| GHSA-v5mp-jgw5-2x6j "Prototype Pollution via `__proto__` key-path desynchronization" | High |

`toml` is imported in exactly one place in stellar-sdk 15.1.0: `lib/*/stellartoml/index.js`,
the Stellar **federation** TOML parser. Verified by grep across `lib/`:

```
lib/stellartoml/index.js
lib/no-eventsource/stellartoml/index.js
lib/minimal/stellartoml/index.js
lib/no-axios/stellartoml/index.js
```

PageSure does not implement or call Stellar federation, so no attacker-controlled TOML is ever
parsed. Fixing would require overriding a transitive `toml` across a major version (3 → 4), which
risks the Stellar SDK for no reachable gain. stellar-sdk 16 replaced `toml` with `smol-toml`, but
16 does not fix axios (see 1). Documented, not overridden.

## Dev-only advisories

`fast-glob` → `micromatch` → `braces` (stack exhaustion) and `toml` reach the tree through
`eslint-config-next`. They affect `npm run lint` only, never the runtime or the gateway. Not
actioned.

## Notes from the install

- **zod 4.6.5 is fine.** An intermediate corrupt `node_modules` (killed install) made
  `zod/mini` fail to resolve because `v4/mini/external.js` was missing. The published tarball
  contains 124 `.js` files including that path; the broken tree had 4. Fixed by a clean
  reinstall, not by changing versions. If `zod/mini` ever fails to resolve again, check
  `find node_modules/zod -name '*.js' | wc -l` before touching versions.
- Native builds (`better-sqlite3`) need `npm install-scripts approve better-sqlite3` in this npm
  version. Deployment must use a Node server or a Docker image with build tooling. This is
  independent of, and additional to, the `Store.memory()` single-process constraint.

## Re-verification

```
npm run mpp:audit    # installed MPP surface + EVM-unreachability proof
npm audit            # advisory status
```