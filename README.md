# HDRI Creator

Web app qui transforme une série de photos bracketées en cartes d'environnement HDRI 32 bits
(`.hdr` Radiance et `.exr` OpenEXR), prêtes pour Blender, Unreal, Unity, Houdini, Nuke, etc.

Tout le calcul se fait **dans le navigateur** : aucune photo n'est envoyée sur un serveur.

## Pourquoi une web app (et pas une app macOS native)

| | Web app (choix retenu) | App macOS native |
|---|---|---|
| Installation | Aucune, une URL | Signature, notarisation, mises à jour |
| Plateformes | macOS, Windows, Linux, iPad | macOS seulement |
| Confidentialité | Photos traitées localement | Idem |
| Performance | Workers en parallèle + WebGL2 ; 5 × 24 Mpx → HDRI 4K en ~10 s | Un peu plus rapide, et lecture des RAW plus simple |
| Coût d'hébergement | Gratuit (GitHub Pages, fichiers statiques) | — |

La limite principale du web, c'est que les navigateurs ne décodent pas les fichiers RAW (CR3, NEF, ARW…).
Il faut exporter en JPEG (ou PNG). Si la fusion directe des RAW devient indispensable, le cœur du
traitement (`src/core/`, en TypeScript pur) peut être réutilisé dans une coquille Tauri pour macOS.

## Fonctionnement

1. **Import** : glisser-déposer les photos. L'EXIF (temps de pose, ouverture, ISO, date) est lu
   pour calculer l'exposition de chaque photo.
2. **Regroupement** : les photos sont triées par date de prise de vue et découpées en bracketings
   (automatiquement dès qu'une exposition se répète, par paquets de N, ou en un seul HDRI).
   Sans EXIF, les EV sont estimés par luminosité et restent modifiables.
3. **Fusion**, pour chaque bracketing, dans un Web Worker (plusieurs bracketings en parallèle) :
   - alignement par *Median Threshold Bitmap* (Ward 2003), avec garde-fous contre les faux appariements ;
   - estimation de la courbe de réponse de l'appareil (Debevec & Malik 1997) ou sRGB standard ;
   - fusion pondérée, avec un anti-fantômes optionnel pour les éléments en mouvement ;
   - normalisation optionnelle (gris moyen 18 %).
4. **Projection** :
   - *Caméra 360°* (Insta360, Ricoh Theta…) : image équirectangulaire, avec rotation ;
   - *Boule miroir* : on place le cercle sur la boule, conversion vers l'équirectangulaire ;
   - *Photo classique* : HDR non projeté (par exemple pour assembler ensuite dans PTGui ou Hugin).
5. **Export** : `.hdr` (RLE), `.exr` (demi-flottant, compression ZIP), aperçu `.jpg`, ou tout en `.zip`.
   Visionneuse 360° intégrée avec réglage d'exposition.

## Conseils de prise de vue

- Bracketing de 5 à 9 poses espacées de 2 EV, sur trépied si possible.
- Pour capter le soleil, la pose la plus sombre ne doit plus avoir de pixel blanc (filtre ND au besoin).
- Balance des blancs et ouverture fixes sur toute la série.

## Développement

```bash
npm install
npm run dev        # serveur de développement
npm test           # tests unitaires (EXIF, Debevec, fusion, alignement, projections, encodeurs)
npm run build      # build statique dans dist/
```

Le workflow `.github/workflows/deploy.yml` publie `dist/` sur GitHub Pages à chaque push sur `main`
(à activer dans *Settings → Pages → Source : GitHub Actions*).

### Structure

```
src/core/        traitement pur, sans DOM (testable sous Node)
  exif.ts        lecture EXIF JPEG
  grouping.ts    tri et découpage en bracketings
  align.ts       alignement MTB
  crf.ts         courbe de réponse (Debevec) et échantillonnage
  merge.ts       fusion HDR incrémentale (16 octets/pixel)
  projection.ts  équirect, boule miroir, redimensionnement
  writers/       encodeurs .hdr et .exr
  pipeline.ts    orchestration d'un bracketing
src/worker/      Web Worker et file de traitement parallèle
src/ui/          visionneuse 360° WebGL2
src/main.ts      interface
```
