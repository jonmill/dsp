# DSP blueprint sample strings (test fixtures)

These are real blueprint strings copied from public open-source repositories. Each `.txt` file holds exactly one
blueprint string with no trailing newline. The strings were checked with an independent MD5F + binary
decoder/encoder (see `../blueprint-format.md`, section 8):

- **hash** means the stored MD5F hash matches the string.
- **binary RT** means the decompressed body decodes and re-encodes to identical bytes.
- **gzip RT** means `pako.gzip(raw, {level: 6, header: {os: <byte 9 of the original>}})` gives identical
  compressed bytes. That makes the whole string reproduce byte for byte.

| File | Game version | Format features | Contents | hash | binary RT | gzip RT | Source |
|---|---|---|---|---|---|---|---|
| `bab-single-0.10.28.txt` (350 B) | 0.10.28.21014 | header v0; body version 1; legacy building records (no marker); OS byte `0x0B` | 1 x Battlefield Analysis Base (3009/model 453) with 110 params, filtered storage (type 9). Layout 23, icons 3009, 609. Short description "BAB (Filtered for Level 9)", empty description. | OK | OK | OK | https://github.com/sakost/dsp-bp/blob/2874322445fa5f0f82fc870528642c9c87faf59b/src/parsers/factory_bp/blueprint.rs (test `test_parse_blueprint`) |
| `mixed-16-buildings-0.9.24.txt` (875 B) | 0.9.24.11286 | header v0; body version 1; legacy records; `areaSegments` = 160 (not on the equator) | 16 buildings: 11 x Conveyor Belt Mk.I (2001/35; two carry label params `[1002,0]`), 1 x Sorter Mk.I (2011/41, params `[1]`), 1 x Splitter (2020/39, params `[0,0,1,0]`), 1 x ILS (2104/50, 2048 params), 1 x Tesla Tower (2201/44, 0 params), 1 x Arc Smelter (2302/62, recipe 3, params `[0]`). Short description "test", description "test desc". | OK | OK | OK | https://github.com/huww98/dsp_blueprint_editor/blob/5b1a2588243a9bf7115c00ede4757aa42e719dbe/tests/unit/blueprint/parser.spec.ts |
| `ils-configured-0.9.24.txt` (2009 B) | 0.9.24.11286 | header v0; body version 1; legacy records | 1 x ILS (2104/50) + 36 x Conveyor Belt Mk.II (2002/36). The station settings are documented in the blueprint description and were confirmed from params: items 6001-6005 (all matrices), supply/supply, max 10000; 60 MW charging (raw 1000000); drone range 50 degrees (raw 64278761 = cos 50 deg x 1e8); vessel range 6 ly (raw 144000); warp distance 2 AU (raw 80000); orbital collector on; warpers required; drone min load 20 %, vessel min load 40 %; all 12 slots output, storage indexes `[2,2,1,5,5,1,4,4,1,3,3,1]`. The description contains `%0A` and `%2A`, which shows the game percent-escapes `*`. | OK | OK | OK | https://github.com/Wesmania/dspbp/blob/c7746c68701ac7a2a5925c157e054383bb575e4a/examples/Example%20interstellar%20station%201.txt |
| `capsule-production-v2-reform-0.10.33.txt` (9215 B) | 0.10.33.27026 | header v0; **body version 2** with trailer (patch = 1, reform flag = 1, 1 foundation rect); **marker -101** records; OS byte `0x0A` | 331 buildings: 247 x Belt Mk.III (2003/37), 36 x Sorter Mk.III (2013/43, with tilt/pitch/pos2/yaw2/tilt2/pitch2), 9 x Splitter (2020/39, **6** params), 1 x Traffic Monitor (2030/208, 128 params), 9 x Depot Mk.I (2101/51, 110 params, filtered, stacked at z = 2.0), 9 x Logistics Distributor (2107/371, 128 params, z = 3.875, filterId = item), 4 x Tesla Tower (2201/44), 8 x Assembling Machine Mk.II (2304/66, recipe 142, params `[0]`), 8 x Spray Coater (2313/120, 0 params). Raised belts sit at z of about 1.0. (The upstream file name says 0.9.27.15466, but the header says 0.10.33.27026.) | OK | OK | OK | https://github.com/LRFalk01/DSP-Blueprint-Parser/blob/301f6f38de52a0ba9ffc98558762efce14f39fe2/spec/fixtures/blueprint.0.9.27.15466.txt |
| `belts-header-v1-marker-102-0.10.34.txt` (1054 B) | 0.10.34.28326 | **header v1** (15 cells: author `LRFalk01`, custom version `1.1`, attributes `%3AAttribute%201%5C%5Cbait%5Cb%3B`, description `Desc`); body version 2 (patch 1, no reform); **marker -102** records (content flag 0 on every building); OS byte `0x0A` | 37 x Conveyor Belt Mk.I (2001/35) in an 11x11 area. | **MISMATCH** (see note) | OK | OK | https://github.com/LRFalk01/DSP-Blueprint-Parser/blob/301f6f38de52a0ba9ffc98558762efce14f39fe2/spec/fixtures/blueprint.0.10.34.28326.txt |

**Note on the 0.10.34 sample:** the stored hash `5755D03D98DC33191EBEE9D2A123542F` does not match MD5F of the string.
Several variants were tried (header-only, base64-only, the header rewritten as v0, UTF-16, the MD5FC constant
set, and stock MD5); none match. The upstream Ruby test never checks the hash of this file. Either the header
text was edited by hand after export, or v1 headers are hashed differently. Use this file for **decode** tests
only, and do not assert its hash until a fresh in-game export with a v1 header is available.

Other public samples, not copied here: `spec/fixtures/blueprint.txt` (0.8.19, 27 KB, 1119 buildings) and
`spec/fixtures/sphere_blueprint.txt` (a `DYBP:` Dyson-sphere blueprint whose hash also validates with MD5F), both in
LRFalk01/DSP-Blueprint-Parser at the commit above.
