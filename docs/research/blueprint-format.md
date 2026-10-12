# Dyson Sphere Program blueprint string format: codec reference

Status: research document, 2026-10-10. Target game versions are 0.9.x through 0.10.34.x (Dark Fog era).
Samples to test against: `blueprint-samples/` (see its README).

## Evidence labels used in this document

| Label | Meaning |
|---|---|
| **[GAME]** | Taken from decompiled game code (`Assembly-CSharp.dll`, dotPeek), as published in LordMike/dsp-blueprints (game build 0.10.32, committed 2025-03-25). |
| **[SRC xN]** | Agrees across N independent open-source implementations (listed in the Sources section). |
| **[TESTED]** | Checked here by running independent Python and JS implementations against real blueprint strings (section 8). |
| **[INFERRED]** | Reasoned from samples or from a single non-game source. Treat as a hypothesis and add a test. |
| **[UNKNOWN]** | Not settled. Called out under Gaps. |

### Sources (pinned commits)

| Key | Repository and commit | Language | Notes |
|---|---|---|---|
| GAME | https://github.com/LordMike/dsp-blueprints @ `1e9cc9e9` — `src/DysonSphereBlueprints.Gamelibs/Code/{BlueprintData,BlueprintBuilding,BlueprintArea,MD5F,StringExtension,EIconLayout}.cs` | C# (decompiled) | Decompiled from game 0.10.32 (`Patchwork/GameConfig.cs` says `new Version(0,10,32)`). It **reads** markers -100/-101/-102 but **writes** -101. It does not yet have header v1 or the body-version-2 trailer. |
| ITEMS | same repo — `src/DysonSphereBlueprints.ItemStore/Resources/protosets.json` | JSON dump of game protos | Game version `0.10.31.24646`. Authoritative for item IDs and model indexes. |
| HUWW | https://github.com/huww98/dsp_blueprint_editor @ `5b1a2588` (2024-08-24) — `src/blueprint/{parser,md5,planet}.ts`, `tests/unit/blueprint/*.spec.ts` | TypeScript | The cleanest TS codec, with typed parameter parsers and MD5F test vectors. It is out of date: it reads only legacy and -100 records, and **writes only the legacy record format**. |
| CYING | https://github.com/cying314/edit-dspblue-print @ `1b3becec` (2026-02-07) — `src/utils/parser.js`, `src/utils/paramParser/*.js` | JS | The most up-to-date codec. It covers -102, header v1, body version 2 with foundation ("reform") data, and its source comments give the game version where each change appeared. |
| RUBY | https://github.com/LRFalk01/DSP-Blueprint-Parser @ `301f6f38` (2026-01-24) — `lib/dsp_blueprint_parser/*.rb`, `ext/md5f/md5f.c`, `spec/fixtures/*` | Ruby + C | Covers -100/-101/-102 and header v1. Its -102 path does not read the trailing content field. It has real 0.10.33 and 0.10.34 fixtures. |
| TK | https://github.com/johndoe31415/dspbptk @ `bb11f9b9` (2022) — `MD5.py`, `Blueprint.py` | Python | Writes MD5F as stock-MD5 "patches" (a third independent derivation). Also has an `MD5FC` variant and the test vector "Why are you doing this, Youthcat Studio?". |
| WES | https://github.com/Wesmania/dspbp @ `c7746c68` (2023) — `src/data/{station,belt,building,area}.rs`, `examples/` | Rust | Station parameter layout with units. Includes a documented ILS sample. |
| SAK | https://github.com/sakost/dsp-bp @ `28743224` (2025) | Rust | Only its short test string is used. Its -102 belt parsing is **wrong** (it reads pos2 for belts), so do not copy it. |
| DSQ | https://github.com/SXFreell/dsqbpg @ `39491cea` (2026-05) — `src/lib/blueprint/codec.ts` | TS | A port of CYING. Its -101 branch wrongly reads the -102 content field, so do not copy it. |

---

## 1. String envelope

```
BLUEPRINT:<h0>,<layout>,<icon0>,<icon1>,<icon2>,<icon3>,<icon4>,0,<ticks>,<gameVersion>,<shortDesc>,<desc>"<BASE64(GZIP(body))>"<MD5F-HEX-UPPER>
            └──────────────────────── header (comma-separated) ─────────────────────────┘ ^                  ^
                                                                         first '"' ─────┘                  └─── last '"'
```

### 1.1 Header cells

The header is the text after `BLUEPRINT:` and before the first `"`, split on `,`.

| Cell | v0 (all versions up to 0.10.33) | v1 (0.10.34.28281+) | Type and format | Evidence |
|---|---|---|---|---|
| 0 | `0` | `1` | Header version. The game's v0 code writes the literal `"0"` and **never parses** it. | [GAME] writes `"BLUEPRINT:0,"`. The v1 meaning comes from [SRC x2: CYING, RUBY] and the 0.10.34.28326 sample. |
| 1 | layout | layout | int, an `EIconLayout` enum value (table below) | [GAME] |
| 2-6 | icon0..icon4 | same | int icon IDs: `<1000` = signal ID, `1000..19999` = item ID, `20000+recipeId` = recipe, `40000+techId` = tech, 0 = empty | [GAME] for the fields. The ID ranges come from HUWW `src/data/icons.ts` [INFERRED-ish]. |
| 7 | `0` | `0` | Reserved. Always written as `0` and never parsed. | [GAME] |
| 8 | ticks | ticks | .NET `DateTime.Ticks` as a decimal int64: 100 ns units since 0001-01-01 00:00. The game sets it from `DateTime.Now`, so it is **local wall-clock time with no timezone**. | [GAME] `time.Ticks` / `new DateTime(long)` |
| 9 | gameVersion | gameVersion | Not escaped, for example `0.10.33.27026` | [GAME] |
| 10 | shortDesc | shortDesc | Escaped (§1.3). Shown on the blueprint icon. | [GAME] |
| 11 | desc | **author** | Escaped | v0 [GAME]; v1 [SRC x2] |
| 12 | — | **customVersion** | Escaped, free text (for example `1.1`) | [SRC x2] |
| 13 | — | **attributes** | Escaped. RUBY splits it on `;` after unescaping. CYING calls it "extra new-blueprint attributes". | [SRC x2]. The meaning is [INFERRED]. |
| 14 | — | **desc** | Escaped | [SRC x2] |

How the game parses the header [GAME] `BlueprintData.HeaderFromBase64String`:

- The string must be at least 28 characters and start with exactly `BLUEPRINT:`.
- The parser looks for the first `"` at an index from 28 up to 8191. The header is `substring(10, idx-10)` split on `,`.
- It needs **at least 12 cells**, otherwise it reports `HeaderDataError`.
- It reads cells 1-6, 8, 9, 10 and 11. Numbers are parsed with `int.TryParse`/`long.TryParse`, so a bad number becomes 0 and is not an error.

The v0 parser assigns cell 11 as `desc`. An old game client reading a v1 header therefore shows the author as the description. That is harmless.

`EIconLayout` [GAME]: None=0, NoIcon=1, OneIcon=10, OneIconSmall=11, TwoIcon46=20, TwoIcon53=21, TwoIcon59=22,
TwoIcon57=23, TwoIcon51=24, ThreeIcon813=30, ThreeIcon279=31, ThreeIcon573=32, ThreeIcon591=33, FourIcon7913=40,
FourIcon8462=41, FiveIcon57913=50, FiveIconPenta=51.

### 1.2 Quote separators and payload

- **Payload:** everything between the **first** `"` and the **last** `"` [GAME `ContentFromBase64String`]. Descriptions cannot contain a raw `"` because escaping turns it into `%22`.
- **Signature** [GAME `CheckSignature`]:
  - The game scans backwards for the last `"` within the final 36 characters of the string.
  - It requires at least 32 characters after that quote.
  - It compares exactly the next 32 characters, case-sensitively (`StringComparison.Ordinal`), with `MD5F.Compute(str.Substring(0, idx))`.
  - Characters after those 32 (for example a trailing newline) are ignored. Your decoder should still `trim()` the input.
- **Base64:** the standard alphabet (`+/`) with `=` padding and no line breaks (`Convert.ToBase64String`/`FromBase64String`) [GAME][TESTED].
- **Gzip:** a complete RFC 1952 gzip member from .NET `GZipStream`. All samples have the same header: `1f 8b 08 00 00000000 00 OS`, meaning no FLG bits, `MTIME=0` and `XFL=0` [TESTED]. The OS byte varies:
  - `0x0B` in every sample from ≤0.10.28.
  - `0x0A` in the 0.10.33.27026 and 0.10.34.28326 samples. This is probably a runtime/zlib change [INFERRED].
  - The game does not check the OS byte. Keep it if you want byte-exact round-trips.
- **Deflate settings** [TESTED]: every sample's deflate stream is reproduced **byte for byte** by zlib at level 6 (the default), windowBits 15 and memLevel 8 with the default strategy. In TS: `pako.gzip(raw, { level: 6, header: { os: 0x0A } })` (pako 2.x; `header.time` defaults to 0). Section 8 has the proof.

### 1.3 Text escaping

- **Writing** [GAME `StringExtension.Escape`]: `Uri.EscapeDataString(s)`. The samples [TESTED] show the game escapes `!` → `%21`, `(` `)` → `%28` `%29` and `*` → `%2A`, and writes uppercase hex (`%2C`, `%26`, `%0A`).
  - So the game follows RFC 3986 strictly: only `A-Z a-z 0-9 - _ . ~` stay unescaped, and non-ASCII text becomes percent-encoded UTF-8.
  - JS `encodeURIComponent` leaves `! ' ( ) *` unescaped, so it does **not** match. Use:
    ```ts
    const escape = (s: string) =>
      encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    ```
    The `'` → `%27` case is [INFERRED]: no sample contains `'`.
- **Reading** [GAME `Unescape`]: `Uri.UnescapeDataString`. It is lenient and leaves malformed `%` sequences as they are, whereas `decodeURIComponent` throws on them. Use a tolerant decoder.
  - The game would also accept the `encodeURIComponent` output that CYING/HUWW write, because the hash covers whatever text is present.
- **Byte-exact round-trips:** keep the **raw header cell strings** next to the decoded values. Re-emit the raw cells unless the user edits that field.

### 1.4 Hash coverage

`hash = MD5F( UTF8( str.substring(0, indexOfLastQuote) ) )`. The hashed text runs from `BLUEPRINT:` through the end of the base64, **not including** the closing `"`. The hash is written as 32 **uppercase** hex characters (`ArrayToHexString(..., uppercase:true)`) [GAME][SRC x4][TESTED].

The text is ASCII in practice, so UTF-8 and Latin-1 give the same bytes.

The encoder must append `'"' + hash` after hashing [GAME `ToBase64String`].

### 1.5 Timestamp handling (precision trap)

Ticks such as `637818182165693716` exceed 2^53, so a JS `number` cannot hold them exactly. HUWW and CYING both use `parseInt(...)/10000`, which loses precision and breaks byte-exact round-trips.

**Store ticks as `bigint` or keep the raw decimal string.** Conversion: `unixMs = (ticks - 621355968000000000n) / 10000n`. The value is local time, so treat it as a naive timestamp.

### 1.6 Other prefixes

`DYBP:` is a Dyson-sphere blueprint with a different header (`DYBP:0,<ticks>,<gameVersion>,<type>,<n>"<b64>"<hash>`). It also validates with MD5F [TESTED on RUBY `sphere_blueprint.txt`]. It is out of scope here.

---

## 2. MD5F (the game's modified MD5)

MD5F is **standard MD5** with the same structure, round functions, message order, shift table, padding, little-endian length and little-endian digest output. It changes only:

1. **two of the four initial state words**, and
2. **eight of the 64 additive constants `K[i]`**.

The changes are confirmed in three independent places: decompiled `MD5F.cs` [GAME], `md5.ts` [HUWW], and the patch table in `MD5.py` [TK]. The diff against standard MD5 was computed programmatically [TESTED].

| Item | Standard MD5 | MD5F |
|---|---|---|
| A (init) | `0x67452301` | `0x67452301` (same) |
| **B (init)** | `0xEFCDAB89` | **`0xEFDCAB89`** (C# `4024216457U`) |
| C (init) | `0x98BADCFE` | `0x98BADCFE` (same) |
| **D (init)** | `0x10325476` | **`0x10325746`** (C# `271734598U`) |
| **K[1]** (round 1, step 2) | `0xE8C7B756` | **`0xE8D7B756`** |
| **K[6]** | `0xA8304613` | **`0xA8304623`** |
| **K[12]** | `0x6B901122` | **`0x6B9F1122`** |
| **K[15]** | `0x49B40821` | **`0x39B40821`** |
| **K[19]** (round 2, step 4) | `0xE9B6C7AA` | **`0xC9B6C7AA`** |
| **K[21]** | `0x02441453` | **`0x02443453`** |
| **K[24]** | `0x21E1CDE6` | **`0x21F1CDE6`** |
| **K[27]** | `0x455A14ED` | **`0x475A14ED`** |
| Shift amounts S | 7,12,17,22 / 5,9,14,20 / 4,11,16,23 / 6,10,15,21 | **unchanged** |
| F/G/H/I functions, message index order, padding, output byte order | standard | **unchanged** |

TK also defines an `MD5FC` variant: MD5F plus `K[3]=0xC1BDCEEF`, `K[24]=0x23F1CDE6` and `K[34]=0x6D9D6121`. It is **not** used for factory blueprints [TESTED: all valid samples use MD5F]. Its purpose is [UNKNOWN].

### 2.1 Full MD5F constant tables (0-indexed i = 0..63)

```ts
const K = new Uint32Array([
  0xd76aa478, 0xe8d7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304623, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b9f1122, 0xfd987193, 0xa679438e, 0x39b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xc9b6c7aa, 0xd62f105d, 0x02443453, 0xd8a1e681, 0xe7d3fbc8,
  0x21f1cde6, 0xc33707d6, 0xf4d50d87, 0x475a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
// shift per step: S[(i>>4)*4 + (i&3)]
const S = [7, 12, 17, 22,  5, 9, 14, 20,  4, 11, 16, 23,  6, 10, 15, 21];
// message word index g(i): i<16: i | i<32: (5i+1)%16 | i<48: (3i+5)%16 | else: (7i)%16
const INIT = [0x67452301, 0xefdcab89, 0x98badcfe, 0x10325746];
```

### 2.2 Reference implementation (TypeScript; tested in Node 22)

```ts
export function md5f(bytes: Uint8Array): string {
  const n = bytes.length;
  const padLen = (((n + 8) >> 6) + 1) << 6;            // room for 0x80 + 8-byte bit length
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (n * 8) >>> 0, true);        // bit length, low word
  dv.setUint32(padLen - 4, Math.floor(n / 0x20000000), true); // bit length, high word
  let a0 = 0x67452301 | 0, b0 = 0xefdcab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325746 | 0;
  for (let off = 0; off < padLen; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16)      { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d;          g = (3 * i + 5) & 15; }
      else             { f = c ^ (b | ~d);       g = (7 * i) & 15; }
      f = (f + a + K[i] + dv.getUint32(off + g * 4, true)) | 0;
      a = d; d = c; c = b;
      const s = S[(i >> 4) * 4 + (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true)); // little-endian words
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, '0');
  return hex.toUpperCase();
}
// hash of a blueprint: md5f(new TextEncoder().encode(str.slice(0, str.lastIndexOf('"'))))
```

### 2.3 Test vectors

| Input (UTF-8) | MD5F (uppercase hex) | Origin |
|---|---|---|
| `""` (empty) | `84D1CE3BD68F49AB26EB0F96416617CF` | HUWW `md5.spec.ts`, TK `MD5.py` |
| `"a"` | `F10BDDAECB62E5A92433757867EE06DB` | HUWW, TK |
| `"abcd"` | `FA27C78B6EC31559F0E760CE3F2B03F6` | HUWW, TK |
| `"Why are you doing this, Youthcat Studio?"` | `13424E12890A3F50A1F8567C464FFF8C` | TK |
| `"x"` × 56 (padding needs a second block) | `8BB5C3FC1CB5BFD1EF91C6FB26DA3C44` | computed here: Python and JS ports agree |
| `"x"` × 64 | `F0ADCCB26B1EEDB00EF3F8C5B002EAB5` | computed here: Python and JS ports agree |
| `blueprint-samples/bab-single-0.10.28.txt` minus the final `"`+32 | `09DCE7720CA8695F93D0C611DD833255` | real game export (SAK) |
| `blueprint-samples/mixed-16-buildings-0.9.24.txt` | `A7DF4C8BFFFC74EA6F1C5C2F8CA778BB` | real (HUWW) |

---

## 3. Binary body (after base64 → gunzip)

All values are **little-endian**. `float32` is IEEE-754 single precision (C# `BinaryWriter.Write(float)`). There is no alignment or padding.

### 3.1 Top level

| # | Field | Type | Notes | Evidence |
|---|---|---|---|---|
| 1 | `version` (game name: `patch`) | int32 | `1` from at least 0.8 through 0.10.32 (`CURRENT_PATCH = 1`, `PATCH_POLE_AREA_BUG`). `2` from **0.10.33.26934** (2025-09-29), which adds the trailer in rows 9-11. If it is `< 1`, the game runs `DataRepair()`: when the first or last area has `areaSegments == 4 && anchorLocalOffsetX == 17`, every area's `anchorLocalOffsetX` is set to 0. | [GAME] for ≤1. Version 2: [SRC CYING] plus the 0.10.33/0.10.34 samples [TESTED] |
| 2 | `cursorOffset.x` | int32 | grid cell of the paste cursor inside the cursor's area | [GAME] |
| 3 | `cursorOffset.y` | int32 | | [GAME] |
| 4 | `cursorTargetArea` | int32 | index of the area the cursor is in | [GAME] |
| 5 | `dragBoxSize.x` | int32 | selection box width in grid cells (default 1) | [GAME] |
| 6 | `dragBoxSize.y` | int32 | | [GAME] |
| 7 | `primaryAreaIdx` | int32 | The blueprint is valid only if `>= 0`. The game also requires `-1 <= primaryAreaIdx <= areaCount`. | [GAME] |
| 8 | `areaCount` | **uint8** | 0..64; anything else is "Corrupt Data". Followed by `areaCount` area records (§3.2). | [GAME] |
| 9 | `buildingCount` | int32 | 0..1048576. Followed by building records (§3.3). | [GAME] |
| 10 | *(version ≥ 2)* `patch2` | int32 | Observed as `1` in both samples. CYING calls it a "reserved field". | [SRC CYING][TESTED] |
| 11 | *(version ≥ 2)* `hasReform` | uint8 | 0 = no foundation data. Non-zero means a reform block (§3.5) follows. | [SRC CYING][TESTED] |

After reading, the game links `outputObj`/`inputObj` by index (`tempOutputObjIdx >= 0` → `buildings[idx]`).
`CheckBuildingData()` **drops any building whose `index != its array position`** and re-indexes the rest. Encoders must therefore write `index == position` [GAME].

### 3.2 Area record (14 bytes)

| Field | Type | Meaning | Evidence |
|---|---|---|---|
| `index` | int8 | area index (position in the array) | [GAME] |
| `parentIndex` | int8 | -1 for the root area, otherwise the index of the parent area (the neighbouring latitude band) | [GAME] |
| `tropicAnchor` | int16 | the child area's anchor longitude, in the parent's grid columns (HUWW `findPosForAreas`: `anchor = parentLongitude + tropicAnchor * gridSize[parent]`) | [GAME] field; meaning [SRC HUWW] |
| `areaSegments` | int16 | longitude segment count of the latitude band the area was copied from. 200 at the equator of a standard planet (each segment = 5 grid columns, so 1000 columns around the equator); smaller toward the poles (160, 120, 100, 80, 60, 40, 32, 20, 16, 8, 4, 1) | [GAME] field; band table [SRC HUWW `planet.ts`] |
| `anchorLocalOffsetX` | int16 | for child areas, the offset of the anchor inside this area | [GAME] |
| `anchorLocalOffsetY` | int16 | latitude offset of this area relative to its parent (child latitude = parent latitude + Y) | [SRC HUWW] |
| `width` | int16 | area size in grid columns | [GAME] |
| `height` | int16 | area size in grid rows | [GAME] |

A blueprint inside one latitude band has a single area: `{0, -1, 0, 200, 0, 0, w, h}` (default `ResetAsEmpty`: segments 200, size 1×1).

### 3.3 Building record

The first int32 is either the **building index** (legacy format, value ≥ 0) or a **format marker ≤ -100**. The game branches on `num <= -102`, then `<= -101`, then `<= -100`, otherwise legacy [GAME][SRC CYING, RUBY][TESTED].

Within the -101 and -102 formats, "belt" means `2000 < itemId < 2010` and "sorter" means `2010 < itemId < 2020`. These ranges come from the game code. Splitter 2020 is **not** a sorter; Pile Sorter 2014 **is** a sorter.

#### Format L (legacy, all versions up to 0.10.29): 61 bytes + 4·paramCount

| Field | Type |
|---|---|
| index (no marker) | int32 |
| areaIndex | int8 |
| localOffset x, y, z | float32 ×3 |
| localOffset2 x2, y2, z2 | float32 ×3 |
| yaw, yaw2 | float32 ×2 |
| itemId | int16 |
| modelIndex | int16 |
| *(common tail)* | see below |

Readers set tilt = pitch = tilt2 = pitch2 = 0.

#### Format -100 (0.10.30.22239, 2024-05-29: belt tilt added): 69 bytes + 4·paramCount

`int32 -100`, `int32 index`, then the same fields as L up to and including `yaw2`, then **`float32 tilt`**, then `itemId`, `modelIndex` and the common tail. Readers set tilt2 = pitch = pitch2 = 0 [GAME].

#### Format -101 (0.10.31.24646, 2024-11-30, through 0.10.33): 49 bytes (+4 belts / +32 sorters) + 4·paramCount

| Field | Type | Present when |
|---|---|---|
| marker `-101` | int32 | always |
| index | int32 | always |
| itemId | int16 | always (**moved before position**) |
| modelIndex | int16 | always |
| areaIndex | int8 | always |
| localOffset x, y, z | float32 ×3 | always |
| yaw | float32 | always |
| tilt | float32 | belt **or** sorter |
| pitch | float32 | sorter |
| localOffset2 x2, y2, z2 | float32 ×3 | sorter |
| yaw2 | float32 | sorter |
| tilt2 | float32 | sorter |
| pitch2 | float32 | sorter |
| *(common tail)* | | always |

Defaults when a field is absent [GAME]:
- belt: `offset2 = offset`, `yaw2 = yaw`, `tilt2 = tilt`, `pitch = pitch2 = 0`.
- other buildings: `offset2 = offset`, `yaw2 = yaw`, and all tilt/pitch values 0.

#### Format -102 (game emits it from 0.10.34.28281, 2026-01-22; the reader exists in 0.10.32 code): -101 + content

Identical to -101, followed by:

| Field | Type | Notes |
|---|---|---|
| contentFlag | int32 | `> 0` means a string follows. The game reads only the sign. |
| content | .NET `BinaryWriter.Write(string)`: 7-bit-encoded (LEB128) **UTF-8 byte length**, then the UTF-8 bytes | present only when contentFlag > 0 |

Evidence: [GAME] read path; [SRC CYING]; [TESTED] on the 0.10.34 sample, where every flag = 0. **[UNKNOWN]**: the value the game writes for `contentFlag` when content exists. CYING writes `content.length`. Preserve the raw int.

What `content` holds is [INFERRED]: probably the text on the 0.10.32+ Holo Beacon (item 2401), and maybe other labels.

#### Common tail (every format)

| Field | Type | Meaning | Evidence |
|---|---|---|---|
| outputObjIdx | int32 | index of the building this one outputs to, or -1. Belts: the next belt or building downstream. Sorters: the building or belt dropped into. | [GAME] field; meaning [TESTED] from samples |
| inputObjIdx | int32 | index of the input source, or -1. Belts only set it when fed directly by a building (station or splitter); a belt-to-belt chain uses only `outputObjIdx`. | [GAME]; [TESTED] |
| outputToSlot | int8 | slot index on the **output target** (for example, the station slot a belt feeds) | [GAME]; meaning [INFERRED] |
| inputFromSlot | int8 | slot index on the **input source**. A belt leaving ILS slot 8 has `inputFromSlot = 8`; a sorter uses -1 = any. | [GAME]; [TESTED] |
| outputFromSlot | int8 | this building's own output slot | [GAME]; [INFERRED] |
| inputToSlot | int8 | this building's own input slot (belts: always 1) | [GAME]; [TESTED] |
| outputOffset | int8 | sorters: belt-segment offset at the drop point | [INFERRED] |
| inputOffset | int8 | sorters: belt-segment offset at the pick point | [INFERRED] |
| recipeId | int16 | recipe for assemblers/smelters/chemical plants/refineries/colliders/labs; 0 if none | [GAME] |
| filterId | int16 | item filter (sorter filter, distributor item, and so on); 0 = none | [GAME] |
| paramCount | int16 | number of int32 parameters that follow | [GAME] |
| parameters | int32 × paramCount | building-specific (§4) | [GAME] |

The observed slot values for non-connected buildings are themselves a detail to preserve [TESTED]:
- splitters, depots and spray coaters carry `14,15,15,14,0,0`;
- assemblers carry `0,0,0,0,0,0`;
- a belt chain carries `1,0,0,1,0,0`.
- a belt that feeds another belt writes the target's input slot in `outputToSlot`: 1 when it joins from behind (the straight
  run), 2 when it joins from the side (a merge). [TESTED] 0.10.34 sample: record 15 continues record 16 with 1, record 23
  joins it with 2. A corner node that feeds the next belt can also carry 2 (capsule sample record 101), so the slot alone
  does not prove a merge; it only tells apart the feeders of one target. The importer (`blueprint/import.ts`) and the
  builder (`blueprint/build.ts`) use it that way.

Copy the source values exactly. When generating new buildings, use these patterns.

**Spray coaters (2313, model 120) in the capsule sample [TESTED, 8 records].** A coater record has `outputObjIdx = inputObjIdx = -1`
and the `14,15,15,14,0,0` slot fields, no parameters, `pos2 = pos`, `yaw2 = yaw` and tilt and pitch 0. No belt record points at it
and it points at no belt: the sample links coater and belt only by position.
- Each coater stands exactly on a belt record (same x and y, z within 0.01), on a straight run of ground belt.
- All 8 coaters have yaw 180, whichever way their belt flows. They stand in columns x = 1, 2, 3, 7, 9, 10, 14 and 15 (all at y = 17):
  the belts of columns x = 2, 3, 7, 10, 14 and 15 flow south (yaw 180), those of x = 1 and 9 flow north (yaw 0). So a coater is turned
  *along* its belt, either way round.
- One belt at z = 1.00 (1.0 to 1.006) runs along y = 18, north of every coater (which stands at y = 17), crossing the item belts at a
  right angle. It passes the node one step behind each coater (the side its back is on: yaw 180 is south-facing, so north), which
  is the prefab top-passage point `[0, 1.333, -1.25]` m (one level up, 1.25 m = 0.995 tiles behind the origin). It is a dead end that
  ends on the last coater's top point, (1, 17.987); it is fed from the north by a splitter chain, not by a station.
- Every belt runs straight for at least 3 nodes on each side of its coater, and the nearest sorter end is 3.2 tiles from any
  coater (measured on the 8 records).
The planner writes coaters the same way (`blueprint/build.ts`) and reads them back by position (`blueprint/import.ts`). The top
passage and the crossing at a right angle are inferred from this one sample; see Task 30's checklist in the Task 28 report.

### 3.4 What the game writes (for an encoder)

| Game version | Header cell 0 | Body version | Building marker | Trailer | Evidence |
|---|---|---|---|---|---|
| ≤ 0.10.29 | 0 | 1 | none (legacy) | — | samples [TESTED] |
| 0.10.30.x | 0 | 1 | -100 | — | [SRC CYING] |
| 0.10.31-0.10.32 | 0 | 1 | -101 | — | [GAME] Export |
| 0.10.33.x | 0 | **2** | -101 | patch2 + reform | sample 0.10.33.27026 [TESTED] |
| 0.10.34.28281+ | **1** | 2 | **-102** | patch2 + reform | sample 0.10.34.28326 [TESTED decode], [SRC CYING] |

**Recommended output profile for the planner:** header v0, body version 2, marker -101, `patch2 = 1`, `hasReform = 0`. This matches the verified 0.10.33.27026 export exactly, and 0.10.33+ reads it (the current game reads all older formats).
- Use -102 only if you need `content`.
- Use header v1 only after a real v1 export's hash has been verified (see Gaps).
- For the widest compatibility (pre-0.10.33 clients), use body version 1 with no trailer.

### 3.5 Reform (foundation) block (version ≥ 2 and `hasReform != 0`) [SRC CYING][TESTED on 0.10.33 sample]

```
uint8   reserved            // 0
int32   rectCount           // 0..2930400
rect × rectCount:           // 9 bytes each
  uint8  reserved           // 0
  int16  x                  // grid column (area-local)
  int16  y                  // grid row
  uint8  w
  uint8  h
  uint8  data               // high 3 bits = decoration type (0 none, 1-7), low 5 bits = colour index
  uint8  areaIndex
uint32  customReformColorMask
int32   colorCount
uint32 × colorCount         // custom colours (presumably 0xAABBGGRR / RGBA packed — [INFERRED])
```

The sample has one rect `{x:0, y:0, w:16, h:27, data:0x20 (type 1, colour 0), area 0}`.

---

## 4. Building parameters (int32 array)

**Codec rule:** treat `parameters` as an opaque `Int32Array` and keep its **exact length**. Decode typed views lazily on top of it.

The upstream libraries pad to fixed sizes (HUWW writes 2048 for stations, 4 for splitters, 110 for depots). Real data varies by game version: the splitter has 4 ints in 0.9 and **6** in 0.10.33, and 0.8 assemblers have 0 params where 0.9+ has 1 [TESTED]. Rewriting to a fixed size breaks byte-exactness and can drop new fields.

| Building (itemId) | Count | Layout (index: meaning) | Evidence |
|---|---|---|---|
| Conveyor belts 2001/2002/2003 | 0 or 2 | 0: label icon ID (item/signal ID), 1: label number. Absent means no label. | [SRC HUWW, CYING, WES][TESTED] |
| Sorters 2011/2012/2013/2014 | 1 | 0: length in grid cells (1-3). Pile Sorter 2014: speed does not depend on length (CYING). The sorter's item filter is in `filterId`, not in params. | [SRC x2][TESTED] |
| Assemblers 2303/2304/2305/2318, smelters 2302/2315/2319, refinery 2308, chem 2309/2317, collider 2310 | 1 (0.9+), 0 (0.8) | 0: proliferator mode, 0 = extra products, 1 = production speedup. Recipe goes in `recipeId`. | [SRC HUWW, CYING][TESTED] |
| Matrix Lab 2901 / Self-evolution Lab 2902 | 2 | 0: research mode (0 none, 1 matrix synthesis, 2 research), 1: proliferator mode | [SRC x2] |
| Spray Coater 2313 | 0 | none | [TESTED] (0.10.33 sample) |
| Tesla Tower 2201 | 0 | none | [TESTED] |
| Wireless Power Tower 2202, Satellite Substation 2212 | 0 observed for 2212 | none known | 2212 [TESTED in 0.8 sample]; 2202 [UNKNOWN] |
| Splitter 2020 | 4 (≤0.9) / 6 (0.10.33) | 0-3: port priority flags (1 = priority, 0 = normal), ports in the model's order. 4-5: unknown (0 in the sample). Model 38/39/40 = splitter variants (39 is the narrow "single-line" model, per HUWW `SpitterInfo.vue`). | [SRC HUWW, CYING][TESTED] |
| Traffic Monitor 2030 | 128 | 0 targetBeltId (runtime ID, not meaningful), 1 offset, 2 target flow (0.1-item units), 3 period (s), 4 pass operator (0 =, 1 ≠, 2 ≥, 3 >, 4 ≤, 5 <), 5 pass colour, 6 fail colour, 7 tone, 8 volume, 9 pitch, 10 system-warning mode, 11 repeat (1/0), 12 alarm mode, 13 length ×10000, 14 cargo filter item, 17 system-warning icon, 18/19 falloff radius ×10, 20 spawn mode (0 none, 1 generate, 2 consume), 21 digital-signal "IP" (CYING, 2026) | [SRC HUWW, CYING] |
| Depot Mk.I 2101 / Mk.II 2102 | 110 | 0: number of grids blocked from automation, 1: type (0 plain, 9 filtered), 10..10+N-1: per-grid filter item (N = 30 for Mk.I, 60 for Mk.II) | [SRC x2][TESTED: `[20,9,…,1607,…]`] |
| Storage Tank 2106 | 2 | 0: output enabled (1/-1), 1: input enabled (1/-1) | [SRC x2] |
| Logistics Distributor 2107 | 128 | 0 Icarus mode (1 recycle, 2 supply+recycle, 3 supply), 1 distributor mode (0 none, 1 supply, 2 demand), 2 workEnergyPerTick, 3 courier auto-replenish (1/0). Item in `filterId`. | [SRC x2][TESTED: `[1,2,30000,1]`] |
| **PLS 2103 / ILS 2104 / Advanced Mining Machine 2316** | **2048** | see §4.1 | [SRC HUWW, CYING, WES][TESTED] |
| EM-Rail Ejector 2311 | 2-3 | 0 orbit ID, 1 ×10 fire rate (1/0), 2 auto-orbit (1/0, CYING) | [SRC x2] |
| Ray Receiver 2208 | 1 | 0: product (0 = power, 1208 = photons) | [SRC x2] |
| Energy Exchanger 2209 | 1 | 0: mode (-1 discharge, 0 standby, 1 charge) | [SRC x2] |
| Artificial Star 2210 | 1 | 0: boost (1/0) | [SRC HUWW] |
| Vertical Launching Silo 2312 | 1 | 0: ×10 rate (1/0) | [SRC CYING] |
| Battlefield Analysis Base 3009 | 110 | storage block like Depot Mk.II (60 grids). Then at base = 10, or 70 when filtered: +0 workEnergyPerTick, +1 auto-pick, +2 auto-replenish fleet, +3 combat enabled, +4 auto-reconstruct, +5 construction drones enabled, +6 drone priority (0 repair, 1 balanced, 2 construct), +7..+18 fighter item IDs | [SRC x2][sample `bab-single`] |
| Turrets 3001-3010 | 128 | 1 group (0-5), 2 target priorities (2 bits each: ground, low-air, high-air, space; 0 off, 1 low, 2 balanced, 3 high), 3 jammer phase ×60 | [SRC CYING] |
| Holo Beacon 2401 (0.10.32+) | 2048 | 0 colour, 1 height ×100, 2 radius ×100, 3 visibility (0-4), 4 detail level (0-3), 5 icon, 6 digital-signal IP | [SRC CYING] only |

### 4.1 Station parameters (2048 int32) — PLS 2103, ILS 2104, Advanced Mining Machine 2316

| Index | Field | Encoding / units |
|---|---|---|
| `6·i + 0`, i = 0..4 | storage[i].itemId | item ID, 0 = empty. PLS uses i < 4, ILS i < 5, AMM i < 1 (old 0.8 PLS used 3) |
| `6·i + 1` | storage[i].localLogic | 0 storage, 1 supply, 2 demand |
| `6·i + 2` | storage[i].remoteLogic | 0 storage, 1 supply, 2 demand (ILS only) |
| `6·i + 3` | storage[i].max | item cap |
| `6·i + 4` | storage[i].keepMode (lock) | 0 not locked; otherwise locked (HUWW: "lock capacity to max/keepMode"; CYING: 1 full, 2 half) |
| `6·i + 5` | unused | 0 |
| `192 + 4·s + 0`, s = 0..11 | slot[s].dir | 0 none, 1 output, 2 input |
| `192 + 4·s + 1` | slot[s].storageIdx | **1-based** storage index to output (0 = none; 6 = warper per CYING) |
| `192 + 4·s + 2..3` | unused | 0 |
| 320 | workEnergyPerTick | max charging power in J/tick. MW = raw × 60 / 1e6 (1,000,000 = 60 MW) |
| 321 | tripRangeOfDrones | `round(cos(maxAngleDeg) × 1e8)`. 50° → 64278761 |
| 322 | tripRangeOfShips | metres / 100. 1 ly = 24000. "Unlimited" = 10000 ly (CYING) |
| 323 | includeOrbitCollector | 1 yes, -1 (or ≤ 0) no |
| 324 | warpEnableDistance | metres. 1 AU = 40000 |
| 325 | warperNecessary | 1 yes, -1 (or ≤ 0) no |
| 326 | deliveryAmountOfDrones | minimum load % (1-100) |
| 327 | deliveryAmountOfShips | minimum load % (1-100) |
| 328 | pilerCount | output stack count, 0 = technology maximum, 1-4 = fixed |
| 329 | miningSpeed | Advanced Mining Machine only (percent, for example 100) |
| 330 | droneAutoReplenish | 1/0 |
| 331 | shipAutoReplenish | 1/0 |
| 332..2047 | unused or unknown | 0 in the samples. Preserve them. |

Evidence: [SRC HUWW `stationParamsParser`, CYING `getStationParamsParser`, WES `station.rs`]. Every value in the WES ILS sample was decoded and matches its written description [TESTED].

Slots run counter-clockwise from the rightmost north slot (WES comment) [INFERRED].

---

## 5. Coordinate system

[SRC HUWW `planet.ts`] unless noted.

- **Grid.** On a planet with `segment` = 200 (the standard radius-200 planet), the equator has 200 × 5 = 1000 grid columns. Latitude grid size = 2π / (segment·5) rad.
  - Planets are split into latitude bands. Each band has its own longitude segment count (the `areaSegments` list in §3.2) and so its own column width. That is why a blueprint spanning several bands has several areas linked by parentIndex.
- **localOffset.x / .y:** float32 **grid units** relative to the building's area origin.
  - x = longitude columns, using that area's column width (`2π / (area.segments · 5)` rad).
  - y = latitude rows.
  - World position: `longitude = (areaLongitude + x) · lonGrid`, `latitude = (areaLatitude + y) · latGrid`.
  - Buildings snap to integers, or to .5 for even-sized footprints. Belts and sorters have fractional values (for example 4.9417, 1.8516) because they follow curves [TESTED].
- **localOffset.z:** height in **height-grid units of 4/3 m** (`HEIGHT_GRID_SIZE = 4/3`; radius = R + z·4/3) [SRC HUWW].
  - Observed values [TESTED]: ground objects z ≈ 0 (belts carry tiny offsets such as 0.0017 or 0.0225); raised belts z ≈ 1.0; a stacked Depot Mk.I z = 2.0 (the depot is 2.67 m = 2 units tall); Logistics Distributor on top z = 3.875.
  - That belt layer *n* sits at z ≈ *n* is [INFERRED] from the samples. Confirm it against an in-game export of stacked belts.
- **localOffset2 / yaw2:** the second end-point. It matters only for **sorters**, where (x, y, z) is the pick end and (x2, y2, z2) the drop end; in -101/-102 records the second point is stored only for sorters.
  - Legacy and -100 records always store both points. They are equal for buildings, and also equal for belts in practice.
- **yaw:** degrees, clockwise around the local up axis. HUWW applies `rotation.set(-lat, lon, -yaw·π/180, 'YXZ')`. Values are near 0/90/180/270 for buildings, while belts show arbitrary angles such as 130.7.
- **tilt / pitch:** degrees. Belts: a slope `tilt` (0.10.30+). Sorters: `tilt`, `pitch`, `tilt2`, `pitch2` per end (observed values such as 359.7988 = -0.2°).
- **Area anchors:** child latitude = parent latitude + `anchorLocalOffsetY`. Child anchor longitude = parent longitude + `tropicAnchor` × (parent column width in the lcm grid). HUWW's `findPosForAreas` has the full algorithm.
- **Belt connectivity:** a belt chain is a linked list through `outputObjIdx`, with `outputToSlot = 1` and `inputToSlot = 1`. A belt that ends in a building sets `outputToSlot` = that building's slot. A belt that starts at a building sets `inputObjIdx` = the building and `inputFromSlot` = its slot (§3.3).

---

## 6. Item and model IDs

Authoritative source: ITEMS (`protosets.json`, game 0.10.31.24646). `ModelIndex` is the base model; `ModelCount > 1` means models `ModelIndex .. ModelIndex+count-1` are valid variants. The Beacon row comes from CYING `itemsData.js` only.

| Building | itemId | modelIndex | ModelCount | Param count (§4) |
|---|---|---|---|---|
| Conveyor Belt Mk.I | 2001 | 35 | 1 | 0/2 |
| Conveyor Belt Mk.II | 2002 | 36 | 1 | 0/2 |
| Conveyor Belt Mk.III | 2003 | 37 | 1 | 0/2 |
| Sorter Mk.I | 2011 | 41 | 1 | 1 |
| Sorter Mk.II | 2012 | 42 | 1 | 1 |
| Sorter Mk.III | 2013 | 43 | 1 | 1 |
| Pile Sorter (the "Mk.IV" sorter) | 2014 | 483 | 1 | 1 |
| Splitter | 2020 | 38 (variants 38, 39, 40) | 3 | 4/6 |
| Traffic Monitor | 2030 | 208 | 1 | 128 |
| Automatic Piler | 2040 | 257 | 1 | ? |
| Spray Coater | 2313 | 120 | 1 | 0 |
| Tesla Tower | 2201 | 44 | 1 | 0 |
| Wireless Power Tower | 2202 | 71 | 1 | ? |
| Satellite Substation | 2212 | 68 | 1 | 0 |
| Arc Smelter | 2302 | 62 | 1 | 1 |
| Plane Smelter | 2315 | 194 | 1 | 1 |
| Negentropy Smelter | 2319 | 457 | 1 | 1 |
| Assembling Machine Mk.I | 2303 | 65 | 1 | 1 |
| Assembling Machine Mk.II | 2304 | 66 | 1 | 1 |
| Assembling Machine Mk.III | 2305 | 67 | 1 | 1 |
| Re-composing Assembler | 2318 | 456 | 1 | 1 |
| Chemical Plant | 2309 | 64 | 1 | 1 |
| Quantum Chemical Plant | 2317 | 376 | 1 | 1 |
| Oil Refinery | 2308 | 63 | 1 | 1 |
| Fractionator | 2314 | 119 | 1 | ? |
| Miniature Particle Collider | 2310 | 69 | 1 | 1 |
| Matrix Lab | 2901 | 70 | 1 | 2 |
| Self-evolution Lab | 2902 | 455 | 1 | 2 |
| Planetary Logistics Station | 2103 | 49 | 1 | 2048 |
| Interstellar Logistics Station | 2104 | 50 | 1 | 2048 |
| Orbital Collector | 2105 | 117 | 1 | ? |
| Logistics Distributor | 2107 | 371 | 1 | 128 |
| Depot Mk.I | 2101 | 51 | 1 | 110 |
| Depot Mk.II | 2102 | 52 | 1 | 110 |
| Storage Tank | 2106 | 121 | 1 | 2 |
| Mining Machine | 2301 | 57 | 1 | ? |
| Advanced Mining Machine | 2316 | 256 | 1 | 2048 |
| Water Pump | 2306 | 60 | 1 | ? |
| Oil Extractor | 2307 | 61 | 1 | ? |
| Wind Turbine / Thermal / Mini Fusion / Geothermal | 2203 / 2204 / 2211 / 2213 | 53 / 54 / 118 / 255 | 1 | ? |
| Solar Panel / Accumulator / Accumulator (full) | 2205 / 2206 / 2207 | 55 / 46 / 46 | 1 | ? |
| Energy Exchanger / Ray Receiver / Artificial Star | 2209 / 2208 / 2210 | 45 / 73 / 56 | 1 | 1 |
| EM-Rail Ejector / Vertical Launching Silo | 2311 / 2312 | 72 / 74 | 1 | 2-3 / 1 |
| Battlefield Analysis Base | 3009 | 453 | 1 | 110 |
| Gauss / Laser / Implosion / Plasma / Missile / SR Plasma turret | 3001 / 3002 / 3003 / 3004 / 3005 / 3010 | 374 / 373 / 375 / 408 / 407 / 482 | 1 | 128 |
| Jammer Tower / Signal Tower / Planetary Shield | 3006 / 3007 / 3008 | 422 / 403 / 402 | 1 | 128? |
| Holo Beacon (0.10.32+) | 2401 | 664 | ? | 2048 |
| Foundation (not a building record; see reform block) | 1131 | 0 | 0 | — |

**Cross-check notes.**
- HUWW `itemsData.ts` (game ≈0.10.30) matches all of these model indexes.
- CYING's table lists 2317 → 64 and 2902 → 70. Those disagree with the game's protos (376 and 455), so **trust ITEMS**.
- Every itemId/modelIndex pair seen in the samples matches ITEMS [TESTED].

Recipes, items and tech protos (IDs, ingredients, times) are all in the same `protosets.json` (`RecipeProtoSet`, `ItemProtoSet`).

HUWW `src/data/building.ts` lists approximate collision boxes per model in metres (for example ILS 8×34×8, Assembler 4.2×4.6×4.2), which is handy for a renderer.

---

## 7. Sample fixtures

See `blueprint-samples/README.md`. There are five real strings:
- a 350 B single BAB (0.10.28),
- a 16-building mix (0.9.24),
- a fully configured ILS (0.9.24),
- a 331-building v2+reform -101 export (0.10.33),
- a 37-belt -102/header-v1 export (0.10.34; the hash does not validate, see Gaps).

---

## 8. Verification performed (2026-10-10)

1. **MD5F constants** were diffed programmatically against stock MD5 (`K[i] = floor(|sin(i+1)|·2^32)`). They match §2 exactly in GAME `MD5F.cs`, HUWW `md5.ts` and TK `MD5.py`.
2. **Independent Python implementation** (MD5F plus the full body decode/encode from §3, following the GAME branch logic):
   - all four published test vectors pass;
   - every fixture's body is consumed **exactly** (no leftover bytes);
   - re-serialising gives **identical bytes** for legacy, -101 + version 2 + reform, and -102 + version 2 bodies.
3. **Independent JS implementation** (the §2.2 code plus pako 2.x) under Node 22:
   - decode → gunzip → `pako.gzip(raw, {level: 6, header: {os}})` → base64 → MD5F reproduces **6 of 7 test strings byte for byte**: the 0.8.19, 0.9.24 (×2), 0.10.28 and 0.10.33 exports, plus the DYBP sample;
   - the 7th, the 0.10.34 sample, matches byte for byte except for its non-validating hash;
   - the §2.2 code block, extracted verbatim from this document, passes all §2.3 vectors and validates the four good sample files.

So a full byte-exact codec is achievable with pako level 6.

---

## 9. Implementation checklist for the TS codec

- Find the first `"` and the last `"`. Header = `[10, q1)`, payload = `(q1, q2)`, hash = `(q2, q2+32]`. Trim input whitespace.
- Keep: raw header cells (strings), ticks as a decimal string or bigint, gzip OS byte, body version, `patch2`, raw reform block, and per-building marker (-1 / -100 / -101 / -102). Also keep raw float32 bits if you need exact float round-trips; JS `number` holds float32 values exactly, so a `DataView.setFloat32(getFloat32())` round-trip is lossless. Finally keep raw param `Int32Array`s and raw `contentFlag`.
- Writing a building in -101/-102 form drops `pos2`/`yaw2` for non-sorters. Only re-emit with the original marker if you need exactness.
- Validate on decode: `areaCount ≤ 64`, `buildingCount ≤ 1048576`, `index == position`, links within range, and the whole buffer consumed.
- Hash: `md5f(utf8(str.slice(0, q2)))`, compared as uppercase.
- Escaping: as in §1.3 (stricter than `encodeURIComponent`).

## 10. Gaps and open questions

1. **Header v1 hash [UNKNOWN].** The only public v1 sample (RUBY, 0.10.34.28326) **fails** MD5F, and no variant tried matches. CYING (maintained, Feb 2026) writes v1 headers with plain MD5F and is used in practice, so MD5F probably still applies and the fixture was probably edited by hand. Get one fresh in-game 0.10.34 export (with author/version filled in) and check it.
2. **-102 `contentFlag` value** written by the game, and which buildings carry `content` [UNKNOWN]. Probably Holo Beacon text.
3. **Meaning of `patch2`** (always 1) and the exact game code for the version-2 trailer and header v1. Only derived codecs (CYING) cover them, because no newer decompile is public. Decompile `BlueprintData.Import/Export/headerStr` from a current `Assembly-CSharp.dll` when the game files are available.
4. **Parameter layouts not fully known:**
   - splitter ints 4-5;
   - station indexes 332+ (any 0.10.x additions);
   - Wireless Power Tower 2202, Fractionator, Mining Machine, Piler, Orbital Collector, power generators;
   - the colour packing of reform `customReformColors`.
5. **Slot/offset semantics** (`outputFromSlot`, `outputOffset`/`inputOffset`) and the z values for stacked belt layers are inferred from samples. Confirm them with targeted in-game exports.
6. **`'` escaping** (`%27`) is inferred; no sample contains it.
