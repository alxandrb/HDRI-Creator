# HDRI Creator

Web app qui transforme une série de photos (prises dans plusieurs directions et/ou bracketées) en cartes d'environnement HDRI 32 bits
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
   - *Photos dans plusieurs directions* : assemblage automatique en panorama 360°
     (voir ci-dessous) ; chaque direction peut être une photo unique ou un bracketing ;
   - *Caméra 360°* (Insta360, Ricoh Theta…) : image équirectangulaire, avec rotation ;
   - *Boule miroir* : on place le cercle sur la boule, conversion vers l'équirectangulaire ;
   - *Photo classique* : HDR non projeté (par exemple pour assembler ensuite dans PTGui ou Hugin).
5. **Export** : `.hdr` (RLE), `.exr` (demi-flottant, compression ZIP), aperçu `.jpg`, ou tout en `.zip`.
   Visionneuse 360° intégrée avec réglage d'exposition.

## Assemblage de panorama

Pour des photos prises en tournant sur soi-même, même avec une exposition identique :

1. points d'intérêt (coins de Harris + descripteurs binaires orientés) détectés à 800 px de large ;
2. appariement entre toutes les paires, puis rotation relative estimée par RANSAC (modèle de rotation pure) ;
3. focale lue dans l'EXIF (équivalent 24×36), sinon estimée à partir des homographies, sinon réglée à la main ;
4. ajustement global (Levenberg–Marquardt) de toutes les orientations et de la focale ;
5. horizon remis à niveau automatiquement, luminosité égalisée entre photos voisines ;
6. projection en équirectangulaire avec fondu des recouvrements ; les zones non photographiées
   (souvent le zénith ou le nadir) sont remplies par interpolation.

Pour réussir l'assemblage : tourner autour du même point (idéalement autour de l'objectif),
garder environ 30 % de recouvrement entre photos voisines, et faire des rangées vers le haut et vers le bas
qui recouvrent aussi la rangée horizontale. Un ciel bleu sans aucun détail ne peut pas être aligné :
les photos concernées sont signalées comme « non placées ».

Avec une seule exposition par direction, l'HDRI obtenu est bien en 32 bits, mais les zones écrêtées
(soleil, lampes) le restent. Pour un éclairage réaliste, bracketer au moins les directions les plus lumineuses.

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
  stitch/        assemblage : points d'intérêt, rotations, ajustement global, rendu
src/worker/      Web Worker et file de traitement parallèle
src/ui/          visionneuse 360° WebGL2
src/main.ts      interface
```
