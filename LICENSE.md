# License, Data Attribution & Disclaimers

Copyright © 2026 Andrew Voirol. All rights reserved except as granted below.

---

## Part 1 — Software License (PolyForm Noncommercial License 1.0.0)

The Indicatrix Engine source code, WebGPU/WGSL shaders, and accompanying scripts are licensed under the **PolyForm Noncommercial License 1.0.0** (<https://polyformproject.org/licenses/noncommercial/1.0.0/>).

### Acceptance
In order to get any license under these terms, you must agree to them as both strict obligations and conditions to all your licenses.

### Copyright License
The licensor grants you a copyright license for the software to do everything you might do with the software that would otherwise infringe the licensor's copyright in it for any **Permitted Purpose**. However, you may only distribute the software according to [Distribution License](#distribution-license) and make changes or new works based on the software according to [Changes and New Works License](#changes-and-new-works-license).

### Permitted Purpose
A **Permitted Purpose** is any purpose other than a commercial purpose. A commercial purpose includes, without limitation:
- Selling, leasing, licensing, or charging fees for access to the software or derivative works;
- Using the software or its shaders inside a commercial product, paid service, consulting deliverable, or monetized application;
- Offering hosted or managed versions of the software for commercial gain.

Personal experimentation, academic research, educational study, and non-commercial exploration are expressly permitted. For commercial licensing inquiries, contact Andrew Voirol directly.

### Distribution License
The licensor grants you an additional copyright license to distribute copies of the software. Your license to distribute covers distributing the software with changes and new works permitted by [Changes and New Works License](#changes-and-new-works-license).

### Notices
You must ensure that anyone who gets a copy of any part of the software from you also gets a copy of these terms or the URL for them above, as well as copies of any plain-text lines beginning with `Required Notice:` that the licensor provided with the software:

`Required Notice: Copyright © 2026 Andrew Voirol (https://github.com/AndrewVoirol/indicatrix). Licensed for non-commercial use only under the PolyForm Noncommercial License 1.0.0.`

### Changes and New Works License
The licensor grants you an additional copyright license to make changes and new works based on the software for any Permitted Purpose.

### Patent License
The licensor grants you a patent license for the software that covers patent claims the licensor can license, or becomes able to license, that you would infringe by using the software for any Permitted Purpose.

### Fair Use
You may have "fair use" rights for the software under the law. These terms do not limit them.

### No Other Rights
These terms do not allow you to sublicense or transfer any of your licenses to anyone else, or prevent the licensor from granting licenses to anyone else. These terms do not imply any other licenses.

### Patent Defense
If you make any written claim that the software infringes or contributes to infringement of any patent, your patent license for the software granted under these terms ends immediately. If your company makes such a claim, your patent license ends immediately for work on behalf of your company.

### Violations
The first time you are notified in writing that you have violated any of these terms, or done anything with the software not covered by your licenses, your licenses can nonetheless continue if you come into full compliance with these terms, and take practical steps to correct past violations, within 32 days of receiving notice. Otherwise, all your licenses end immediately.

### No Liability & "As-Is" Hardware Disclaimer
**As far as the law allows, the software comes as is, without any warranty or condition, and the licensor will not be liable to you for any damages arising out of these terms or the use or nature of the software, under any kind of legal claim.**

This engine was built for a personal Apple Silicon workstation targeting high-throughput unified memory and WebGPU compute pipelines. No guarantees, compatibility promises, or support obligations are made regarding performance, GPU memory consumption, or driver behavior on other machines, operating systems, or browsers.

---

## Part 2 — Non-Navigational & Operational Weather Disclaimer

**NOT FOR NAVIGATION OR SAFETY-CRITICAL USE.**

Indicatrix renders bathymetric soundings, terrain elevations, hydrological drainage networks, atmospheric wind/cloud forecasts, precipitation radar, and satellite orbital tracks strictly for **artistic, cartographic, and scientific visualization**.
- Do **not** use this software or any data processed by its scripts for marine navigation, aviation, route planning, hazard assessment, emergency response, or operational meteorology.
- Projection morphing, vertical relief exaggeration, shader-based isoline synthesis, and compressed texture sampling intentionally alter geometric and numerical representations for visual legibility.

---

## Part 3 — Third-Party Datasets, APIs & Cartographic Attribution

This repository includes compact baseline elevation/vector assets and provides optional CLI scripts that allow users to fetch external public datasets directly from upstream providers. **All third-party datasets remain the property of their respective creators and are governed by their own upstream licenses and terms of service:**

1. **Global Bathymetry & Topography (GEBCO 2024 & NOAA ETOPO 2022)**
   - **GEBCO Compilation Group**: *GEBCO 2024 Grid* (`doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f`). Used under GEBCO public attribution terms.
   - **NOAA National Centers for Environmental Information (NCEI)**: *ETOPO 2022 15 Arc-Second Global Relief Model* and *Continuously Updated Digital Elevation Model (CUDEM)*. U.S. Government public domain work (17 U.S.C. § 105). Use of NOAA data does not imply endorsement by NOAA or the U.S. Department of Commerce.

2. **Google DeepMind & Google Research — WeatherNext Forecasts (`scripts/fetch-weathernext3.py`)**
   - WeatherNext / GraphCast / GenCast forecast datasets streamed via Google Cloud Public Datasets (`gs://weathernext`) are licensed by **Google LLC under the Creative Commons Attribution 4.0 International License (CC BY 4.0)**.
   - Users running `npm run weather:fetch` retrieve data directly from Google's public Zarr v3 buckets and are responsible for complying with Google's CC BY 4.0 attribution terms and applicable Google Cloud terms.

3. **NOAA NCEP Global Forecast System (GFS)**
   - Synoptic wind, cloud cover, and jet stream grids fetched via `scripts/fetch-or-generate-gfs-wind.ts` and `scripts/fetch-or-generate-gfs-clouds.ts` originate from NOAA NCEP/NOMADS public domain meteorological feeds.

4. **RainViewer Live Doppler Radar API (`scripts/fetch-live-radar.ts`)**
   - Composite precipitation radar mosaics are fetched on demand from the public RainViewer API (`api.rainviewer.com`) and are subject to RainViewer's API terms of use.

5. **CelesTrak / NORAD Orbital Ephemeris (`scripts/fetch-or-generate-tle-starlink.ts`)**
   - Two-Line Element (TLE) and GP orbital element sets are retrieved from CelesTrak (`celestrak.org`) for non-commercial SGP4 orbital propagation visualization.

6. **Natural Earth, HydroSHEDS & Copernicus GLO-30**
   - Vector coastlines, rivers, graticules, and toponymy are derived from **Natural Earth** (public domain) and **WWF HydroSHEDS / HydroLAKES** (licensed for non-commercial/academic use with attribution).
   - Regional 30m alpine overlays (Matterhorn, Mount Fuji, Grand Canyon) are derived from Copernicus DEM GLO-30 / USGS 3DEP public elevation datasets.

7. **Historical Cartographic Homage**
   - The three rendering mediums in Indicatrix are original procedural WGSL shader interpretations paying homage to historical landmarks of physical cartography: **Marie Tharp and Bruce Heezen's** *World Ocean Floor* panorama (1977), **Eduard Imhof's** *Cartographic Relief Presentation* (1965 / Swiss Federal Office of Topography tradition), and **Sir John Herschel's** 1842 ferroprussiate cyanotype process. No affiliation with or endorsement by these estates or institutions is claimed.
