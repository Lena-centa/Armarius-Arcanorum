# Third-Party Notices and Licenses

This project (Armarius Arcanorum) is licensed under the **MIT License** (see [`LICENSE`](LICENSE)).

This file documents third-party open source packages, libraries, datasets, and bundled dependencies used by or distributed with this project, along with their respective licenses and copyright notices.

---

## 1. Overview of Third-Party Dependencies

| Component / Package | Scope | License (SPDX) | Copyright / Upstream |
|---|---|---|---|
| **Pillow** | Python Dependency | `HPND` | Copyright © 1997-2011 Secret Labs AB, 1995-2011 Fredrik Lundh, 2010-2026 Jeffrey A. Clark and contributors ([python-pillow/Pillow](https://github.com/python-pillow/Pillow)) |
| **NumPy** | Python Dependency | `BSD-3-Clause` | Copyright © 2005-2026 NumPy Developers ([numpy/numpy](https://github.com/numpy/numpy)) |
| **@nestjs/\*** | Node.js Gateway | `MIT` | Copyright © 2017-2026 Kamil Mysliwiec ([nestjs/nest](https://github.com/nestjs/nest)) |
| **better-sqlite3** | Node.js Gateway | `MIT` | Copyright © Joshua Wise ([WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) |
| **ipaddr.js** | Node.js Gateway | `MIT` | Copyright © whitequark and contributors ([whitequark/ipaddr.js](https://github.com/whitequark/ipaddr.js)) |
| **mongodb** | Node.js Gateway | `Apache-2.0` | Copyright © 2014-present MongoDB, Inc. ([mongodb/node-mongodb-native](https://github.com/mongodb/node-mongodb-native)) |
| **mongoose** | Node.js Gateway | `MIT` | Copyright © 2010-2026 Automattic / Valeri Karpov ([Automattic/mongoose](https://github.com/Automattic/mongoose)) |
| **reflect-metadata** | Node.js Gateway | `Apache-2.0` | Copyright © Microsoft Corporation ([rbuckton/reflect-metadata](https://github.com/rbuckton/reflect-metadata)) |
| **rxjs** | Node.js Gateway | `Apache-2.0` | Copyright © 2015-2018 Google, Inc., Netflix, Inc., Microsoft Corp. and contributors ([ReactiveX/rxjs](https://github.com/ReactiveX/rxjs)) |
| **zod** | Node.js Gateway | `MIT` | Copyright © 2020 Colin McDonnell ([colinhacks/zod](https://github.com/colinhacks/zod)) |
| **flatpickr** | Frontend Vendored Asset | `MIT` | Copyright © 2017 Gregory Petrosyan ([flatpickr/flatpickr](https://github.com/flatpickr/flatpickr)) |
| **nyanko-devs/danbooru2026** | Optional Data Asset | `MIT` | Nyanko Devs ([Hugging Face](https://huggingface.co/datasets/nyanko-devs/danbooru2026)) |
| **isek-ai/danbooru-wiki-2024** | Optional Data Asset | `CC-BY-SA-4.0` | ISEKAI (`isek-ai`) ([Hugging Face](https://huggingface.co/datasets/isek-ai/danbooru-wiki-2024)) |

---

## 2. Bundled Frontend Assets

### flatpickr (v4.6.13)
- **Path**: `workflow_db/static/vendor/flatpickr/`
- **License**: MIT
- **Copyright**: (c) 2017 Gregory Petrosyan
- **Notice File**: `workflow_db/static/vendor/flatpickr/LICENSE.txt`

---

## 3. Python Runtime Dependencies

The Python parser and worker processes depend on the packages declared in `requirements.txt`:

### Pillow
- **License**: Historical Permission Notice and Disclaimer (HPND) / PIL Software License
- **Copyright**: 
  - Copyright © 1997-2011 by Secret Labs AB
  - Copyright © 1995-2011 by Fredrik Lundh
  - Copyright © 2010-2026 by Jeffrey A. Clark (Alex) and contributors
- **Notice**: Full license texts are preserved in the installed `.dist-info/licenses` directories of the packaged Python environment.

### NumPy
- **License**: BSD-3-Clause
- **Copyright**: Copyright © 2005-2026, NumPy Developers.
- **Notice**: NumPy builds may bundle LAPACK and PocketFFT under compatible BSD/MIT licenses. Full notices are preserved in the installed `.dist-info/licenses` directory.

---

## 4. Node.js & NestJS Gateway Dependencies

The NestJS gateway server relies on dependencies specified in `nest_gateway/package.json` and resolved in `nest_gateway/package-lock.json`.

### Direct Runtime Dependencies
- **`@nestjs/common`**, **`@nestjs/config`**, **`@nestjs/core`**, **`@nestjs/mongoose`**, **`@nestjs/platform-express`**, **`@nestjs/schedule`**: MIT License, Copyright © Kamil Mysliwiec
- **`better-sqlite3`**: MIT License, Copyright © Joshua Wise
- **`ipaddr.js`**: MIT License, Copyright © whitequark and contributors
- **`mongoose`**: MIT License, Copyright © 2010-2026 Automattic / Valeri Karpov
- **`zod`**: MIT License, Copyright © 2020 Colin McDonnell
- **`mongodb`**: Apache-2.0 License, Copyright © 2014-present MongoDB, Inc.
- **`reflect-metadata`**: Apache-2.0 License, Copyright © Microsoft Corporation
- **`rxjs`**: Apache-2.0 License, Copyright © ReactiveX contributors

### Transitive Dependencies Note
The complete transitive dependency tree is recorded in `nest_gateway/package-lock.json`. Licenses represented across transitive dependencies include MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, and CC-BY-4.0 (declared by `caniuse-lite`). When distributing pre-packaged binary distributions containing `node_modules`, all individual package license files are preserved within their respective package directories.

---

## 5. Danbooru-Derived Data Assets

Optional Danbooru lookup databases (`danbooru/danbooru.sqlite3`), vocabulary dictionaries (`danbooru/vocab_sorted.npy`), and tag embeddings (`danbooru/embed_gnn.npy`) are derived from community datasets:

- **`nyanko-devs/danbooru2026`**: MIT (re-audited via Hugging Face API on 2026-08-29: `cardData.license = mit`, tag `license:mit`).
- **`isek-ai/danbooru-wiki-2024`**: **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)** (re-audited via Hugging Face API on 2026-08-29: `cardData.license = cc-by-sa-4.0`, tag `license:cc-by-sa-4.0`).

The derived assets attribute both upstream sources unconditionally. The GNN
embeddings, co-occurrence edges, and semantic categories derive from the
MIT-licensed posts snapshot or project-authored rules; only the wiki-sourced
columns (`tag_alias` aliases, `wiki_traits` trait relationships) are adapted
CC BY-SA 4.0 material. The full per-table provenance, upstream file hashes, and
the commands to rebuild the database from the upstream datasets are documented
in [`danbooru/ASSET_LICENSES.md`](danbooru/ASSET_LICENSES.md), which must
accompany any distribution containing these assets.

---

## 6. License Texts

### MIT License
```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD-3-Clause License (NumPy)
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### HPND License (Pillow)
```text
The Python Imaging Library (PIL) is

    Copyright © 1997-2011 by Secret Labs AB
    Copyright © 1995-2011 by Fredrik Lundh
    Copyright © 2010-2026 by Jeffrey A. Clark (Alex) and contributors

By obtaining, using, and/or copying this software and/or its associated
documentation, you agree that you have read, understood, and will comply
with the following terms and conditions:

Permission to use, copy, modify, and distribute this software and its
associated documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appears in all copies, and that
both that copyright notice and this permission notice appear in supporting
documentation, and that the name of Secret Labs AB or the author not be
used in advertising or publicity pertaining to distribution of the software
without specific, written prior permission.

SECRET LABS AB AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
IN NO EVENT SHALL SECRET LABS AB OR THE AUTHOR BE LIABLE FOR ANY SPECIAL,
INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Apache License, Version 2.0 (MongoDB Driver, RxJS, Reflect-Metadata)
```text
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
```text
You are free to:
- Share: copy and redistribute the material in any medium or format
- Adapt: remix, transform, and build upon the material for any purpose, even commercially.

Under the following terms:
- Attribution: You must give appropriate credit, provide a link to the license, and indicate if changes were made.
- ShareAlike: If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.
- No additional restrictions: You may not apply legal terms or technological measures that legally restrict others from doing anything the license permits.

Full Legal Code: https://creativecommons.org/licenses/by-sa/4.0/legalcode
```

---

## 7. Compliance and Distribution Requirements

When distributing this software (as source or binary package):
1. **Root License**: Preserve [`LICENSE`](LICENSE) containing the MIT License copyright notice.
2. **Third-Party Notices**: Preserve this [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) file.
3. **Data Assets**: If shipping with Danbooru data assets (`--with-danbooru`), preserve [`danbooru/ASSET_LICENSES.md`](danbooru/ASSET_LICENSES.md) and fulfill CC BY-SA 4.0 attribution requirements.
4. **Vendored Files**: Preserve license headers in `workflow_db/static/vendor/` and package metadata in bundled `node_modules` and Python wheels.

