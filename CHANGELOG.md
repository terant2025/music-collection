# Changelog — Terant Music Collection

Historique structuré des versions, en complément du badge affiché dans la topbar
(`v2026.MM.JJ-NN`) et du commentaire `APP_VERSION` en tête de `index.html`.

## v2026.07.12-24 — 🐛 Correctif crash : scan de résolution des pochettes

Signalé par Antoine (dump console) : `Uncaught TypeError: can't access
property "add", _cache.coverDimsChecked is undefined` pendant le scan
"basse résolution" de l'onglet Pochettes, qui s'interrompait net.

**Root cause.** Ce scan est long (centaines d'images, jusqu'à 8s de
timeout chacune, 8 en parallèle) — largement le temps qu'une action
ailleurs dans l'app déclenche `invalidateCache()`, qui fait `_cache = {}`
**en entier** plutôt que de nettoyer des clés précises. Dans le log
fourni, "Auto covers" tournait en même temps et a fini par provoquer ce
reset. Les `Set` créés au début du scan (`coverDimsChecked`,
`lowResCovers`) disparaissaient alors sous les callbacks encore en vol,
faisant planter tout le worker.

**Correctif.** Réinitialisation défensive des deux `Set` juste avant
chaque usage (au lieu de supposer qu'ils survivent tout le scan), et accès
optionnels (`?.size || 0`) dans les messages de progression/fin. Au pire,
quelques marquages déjà faits sont perdus si un reset concurrent survient
en plein scan (rattrapés automatiquement au scan suivant) — mais ça ne
plante plus.

## v2026.07.12-23 — Export/réimport JSON étendu à tout ce qui est persisté

Demandé par Antoine, suite à une question sur la fraîcheur de la
sauvegarde JSON. L'export ne couvrait qu'une partie de ce qui est
réellement dans Supabase, malgré le texte de l'app qui promettait de
"restaurer l'intégralité de la collection".

**Avant** : `albums`, `tracks`, `stockItems`, `lastfmData`, `rymData`,
`associations`, `rymAssociations`, `nextId` seulement.

**Ajouté** : `wishlist` et `trackWishlist`, `notesToReport`,
`trackNoteOverrides`, `trackYoutubeCache`, `listeningEvolution` /
`listeningHeatmap` / `genreEvolution` (avec leurs `computedAt`),
`marketValueHistory`, et `albumTracksCache` (les tracklists complètes —
coûteuses à re-récupérer, un fetch par album).

Version du format JSON passée à 3. `reimportJSON()` reste compatible avec
d'anciens exports (v1/v2) : dans ce cas, wishlist/notes/Insights/tracklists
sont simplement absents de la restauration (avec avertissement explicite
dans la confirmation avant restauration) plutôt que d'écraser
silencieusement les données actuelles avec du vide.

**Volontairement toujours exclus**, avec la même logique que les autres
caches "régénérables" déjà rencontrés dans l'app :
- Les données MusicBee brutes (`musicbee_tracks`) — repliées en index de
  recherche au chargement, pas conservées sous une forme réexportable, et
  de toute façon entièrement régénérées à chaque réimport du XML MusicBee
- Le cache last.fm par morceau (`lastfm_tracks`, ~197k lignes chez
  Antoine) — régénérable via "🎵 Sync morceaux", aurait fait exploser la
  taille du fichier JSON pour une donnée entièrement reconstructible

Le texte de l'onglet Export a été mis à jour pour refléter précisément ce
qui est couvert.

## v2026.07.12-22 — 🐛 2 correctifs critiques (dump console après fusions en masse)

Signalés par Antoine via un dump console pris après une session de
fusions genre/artiste.

**1. "Uncaught SyntaxError: missing ) after argument list".** Les boutons
🔧/✕ du Nettoyage des genres et des artistes passaient la clé du cluster
via `escAttr(key)` à l'intérieur d'un argument JS entre guillemets
simples (`onclick="mergeArtistCluster(3, '...')"`). Or `escAttr()`
échappe les caractères HTML (`&`, `<`, `>`, `"`) mais **pas** l'apostrophe
— et une apostrophe dans un nom d'artiste ou de genre (ex. "Guns N'
Roses") casse la chaîne JS inline, provoquant une erreur de syntaxe non
rattrapable au clic suivant.

Corrigé en remplaçant `escAttr(key)` par `sid(key)` (encodage base64,
alphabet qui ne contient jamais de guillemet ni d'apostrophe) — exactement
le principe déjà appliqué partout ailleurs dans l'app pour ce type
d'embarquement dans un attribut `onclick`. `unsid()` ajouté côté réception
dans `mergeGenreCluster`/`dismissGenreCluster`/`mergeArtistCluster`/
`dismissArtistCluster`.

**2. "Historique intégrité : écriture localStorage échouée (quota ?)" en
boucle.** `snapshotForUndo()` (déclenché avant chaque fusion, pour
permettre "Annuler") stockait jusqu'à **15 copies complètes** du tableau
`albums` — jusqu'à ~46 Mo chez Antoine (2595 albums), très largement
au-dessus de tout quota localStorage réaliste, même après les correctifs
d'egress de la v2026.07.12-15 qui portaient sur des caches bien plus
modestes.

`saveIntegrityLog()`/`loadIntegrityLog()` supprimés : l'historique
"Annuler" des corrections d'intégrité est désormais **purement en
mémoire** — perdu au rechargement de la page, comme `_sourceCmpCache`/
`_globalCmpResults` de l'onglet Audit collection, déjà conçus session-only
pour la même raison. Réduire encore le nombre de snapshots n'aurait pas
suffi à cette échelle (même 2-3 copies complètes resteraient risquées) ;
la bonne solution était de sortir cette donnée de localStorage plutôt que
d'essayer de la faire rentrer dans un quota qu'elle ne respectera jamais.

## v2026.07.12-21 — 📖 Section "À propos" dans la Vue Artiste

Demandé par Antoine : récupérer des infos Discogs, last.fm, Bandcamp,
Genius et MusicBrainz pour enrichir les fiches artistes. Après un tour
d'horizon des faisabilités, phase 1 : les 3 sources directement joignables
depuis le navigateur sans changement d'Edge Function.

- **last.fm** (`artist.getinfo`, même clé API déjà utilisée ailleurs) :
  bio, tags, artistes similaires (cliquables → rouvrent la Vue Artiste sur
  cet artiste), auditeurs/écoutes globaux last.fm — à ne pas confondre
  avec les écoutes personnelles d'Antoine déjà affichées dans l'en-tête.
- **MusicBrainz** : un 2e lookup par artiste (après la recherche déjà
  existante) donne période d'activité, pays, type (personne/groupe), et
  les artistes liés (membres d'un groupe / groupes dont il a fait partie).
- **Wikipédia** (API REST publique, CORS ouvert) : recherche biaisée vers
  un résultat musical, résumé + image si disponible, lien vers l'article.
  FR d'abord, repli EN, pages d'homonymie ignorées.

last.fm et Wikipédia sont chargés en parallèle pendant le pacing
MusicBrainz déjà nécessaire (2 appels séquentiels ~1,1s chacun), pour ne
pas allonger le temps de chargement de la vue. Chaque bloc ne s'affiche
que si sa source a répondu (une source en échec n'empêche pas les autres).

**Laissé de côté pour l'instant** : Discogs (bio d'artiste) et Genius
nécessiteraient un changement d'Edge Function (le 2e, un compte
développeur Genius côté Antoine en plus) ; Bandcamp n'a pas d'API publique
exploitable pour ce genre d'usage.

## v2026.07.12-20 — 🐛 Correctif + lisibilité Vue Artiste

Signalé par Antoine (capture d'écran de la fiche Blur) : "12/11 possédés
(109%)" — incohérence — et demande de distinguer albums / EP / singles.

**Root cause du >100%.** L'ancien compteur "possédés" comparait TOUTES les
sorties possédées de l'artiste (compilations, live, toutes sources
confondues) au nombre d'albums/EP retournés par MusicBrainz seul — un
album possédé mais absent de cette liste MusicBrainz (compilation exclue
du calcul, titre légèrement différent…) gonflait le numérateur sans
gonfler le dénominateur.

**Correctif.** Le taux de complétion se calcule désormais uniquement à
partir des lignes réellement affichées (bornée par construction — ne peut
plus dépasser 100%). Les stats plus larges (écoutes totales, note moyenne,
genres — volontairement "tout ce que tu possèdes de cet artiste",
compilations incluses) restent affichées mais n'entrent plus dans le
calcul du pourcentage.

**Albums / EP / Singles.** La recherche MusicBrainz inclut maintenant les
singles (en plus des albums et EP), limité à 100 résultats par artiste
(plafond MusicBrainz par requête). Nouveaux filtres 💿 Albums (par défaut)
/ 📀 EP / 🎵 Singles / Tout — défaut sur Albums seul pour rester lisible
plutôt que noyer sous des dizaines de singles pour les artistes prolifiques.

**Lisibilité.** En-tête réorganisé : 3 compteurs par type (albums/EP/
singles) + écoutes + note moyenne, genres déplacés sous le nom d'artiste.
Dans la liste, les colonnes note perso / RYM / écoutes sont maintenant
alignées en grille fixe avec un "–" explicite pour les valeurs absentes,
au lieu d'un texte libre qui s'empilait différemment d'une ligne à
l'autre. Le badge de type (EP/Single) ne s'affiche que dans la vue "Tout"
— redondant avec les filtres sinon.

## v2026.07.12-19 — Termes de recherche éditables (modale "IDs manquants")

Demandé par Antoine : la recherche automatique se basait sur le texte
exact stocké dans la fiche (artiste/titre) — si ça ne trouvait rien la
1re fois (orthographe différente côté MusicBrainz/Discogs, article en
tête ou pas, édition sous un titre légèrement différent…), impossible de
relancer autrement qu'en abandonnant la recherche et en collant l'ID à la
main.

Nouveaux champs artiste/titre en haut de la modale, préremplis avec les
valeurs de la fiche mais **modifiables**, avec un bouton 🔍 pour relancer
la recherche (Entrée dans l'un des deux champs fonctionne aussi). Le lien
externe "Chercher sur Discogs.com" se met aussi à jour avec les termes
édités.

`_linkIdTarget` reste uniquement la référence de quel album/morceau
recevra l'ID une fois un résultat choisi — indépendant des termes utilisés
pour le trouver, donc chercher avec un titre simplifié n'affecte pas ce
qui sera effectivement lié.

## v2026.07.12-18 — Vraie recherche Discogs pour "IDs manquants"

⚠️ **Nécessite un déploiement manuel de l'Edge Function** — voir
`get-release-info.ts` fourni séparément.

Suite à la v2026.07.12-17, Antoine a fourni le code source actuel de
l'Edge Function `get-release-info.ts`, ce qui a changé la donne : un
`DISCOGS_TOKEN` est déjà configuré côté serveur (réutilisé par les
branches `discogs`/`discogs_stats` existantes), donc une vraie recherche
Discogs devient possible sans nouvelle dépendance.

**Edge Function.** Nouvelle branche `discogs_search` : interroge
`/database/search` de l'API Discogs (`type=release`), même pattern d'auth
que les branches existantes. Retourne jusqu'à 10 résultats (titre, année,
format, label, pays, vignette).

**App.** `searchDiscogs(artist, album)` ajouté (même moule que
`searchMusicBrainz`, qui existait déjà côté import mais n'était jusqu'ici
jamais exposé dans une UI de sélection manuelle). La modale de liaison
("IDs manquants") a été réécrite pour unifier ses 3 chemins de recherche
derrière un format de résultat normalisé :
- **Discogs** → Edge Function (nouveau)
- **MusicBrainz (album)** → Edge Function, réutilise `searchMusicBrainz()`
- **MusicBrainz (morceau)** → appel direct côté client (l'API MusicBrainz
  publique reste directement joignable pour la recherche, comme ailleurs
  dans l'app — pas de branche Edge Function dédiée pour l'instant)

Le lien externe vers Discogs.com et le champ de collage manuel restent
disponibles en complément de la recherche intégrée, pour les cas où le
bon pressage précis n'apparaît pas dans les résultats.

## v2026.07.12-17 — Import/Export réorganisé en 3 sous-onglets + "IDs manquants"

Demandé par Antoine : basculer l'onglet "Associations" dans Import/Export,
et ajouter une interface pour lier manuellement/rechercher les IDs
manquants (Discogs, MusicBrainz).

**Nouvelle organisation.** Import/Export a maintenant 3 sous-onglets
(même bascule que les boutons de mode de Session notation) :
- **📥 Sources** — contenu existant inchangé (Discogs, MusicBee, RYM,
  last.fm, export/sauvegarde)
- **🔗 Associations** — l'ex-onglet top-level dédié, déplacé tel quel
  (même logique, juste un nouvel emplacement). L'entrée "Associations"
  disparaît de la barre latérale.
- **🆔 IDs manquants** (nouveau, détail ci-dessous)

**IDs manquants.** Deux listes : albums sans `discogsId` **ni**
`mb_release_id`, et morceaux isolés sans `mb_recording_id`. Pour chaque
entrée, une interface de liaison :
- **MusicBrainz** : recherche **live** via l'API publique (release pour un
  album, recording pour un morceau — même principe que la recherche
  artiste de "Discographie manquante"), résultats affichés et cliquables
  pour lier directement. Aucun changement d'Edge Function nécessaire.
- **Discogs** : pas de recherche live possible sans modifier l'Edge
  Function (`get-release-info.ts` n'a aujourd'hui qu'un mode "récupérer
  par ID déjà connu", pas de recherche) — ouvre à la place une recherche
  Discogs.com préremplie dans un nouvel onglet, avec un champ pour coller
  l'ID trouvé. Fonctionne immédiatement, sans dépendre d'un déploiement
  supplémentaire. Un vrai mode recherche Discogs pourrait être ajouté plus
  tard côté Edge Function si le copier-coller s'avère trop fastidieux à
  l'usage.
- Un champ de collage manuel d'ID reste toujours disponible en complément
  (ou en repli si la recherche ne trouve rien).

Lier un album ouvre ensuite sa fiche, pour enchaîner facilement sur un
"🔄 Rafraîchir depuis la source" et récupérer le reste des métadonnées.

## v2026.07.12-16 — 🎤 Nouvelle "Vue Artiste"

Demandée par Antoine, suite à une discussion sur les vues globales de
l'Audit collection ("Divergences Discogs/MusicBrainz" et "Complétion de
discographie") : une vue centrée sur **un** artiste, qui s'appuie sur
MusicBrainz pour lister toute sa discographie — albums possédés **et**
manquants — et y rapatrie ce que l'app sait déjà (note perso, note RYM,
écoutes last.fm, statut wishlist).

**Mécanique.** Réutilise le même pattern de fetch que "Discographie
manquante" (recherche artiste puis release-groups, 2 appels MusicBrainz
publics non-authentifiés), mais construit une liste **fusionnée**
(possédés + manquants dans une seule chronologie) plutôt que juste les
absents. Chargement automatique à l'ouverture — à la demande d'Antoine,
seulement 2 requêtes donc un délai raisonnable, contrairement aux scans en
masse de l'Audit qui restent volontairement à la demande.

**2 points d'entrée**, comme demandé :
- Nouvel onglet dédié "🎤 Vue Artiste" avec une barre de recherche
- Nom d'artiste cliquable (nouveau helper `artistLink()`) dans Collection,
  Discographie, Wishlist albums et Artistes similaires — ouvre directement
  la Vue Artiste sans déclencher le clic de ligne existant (ouverture de
  fiche). Pas étendu à Pochettes/Audit/Insights pour cette 1ère passe,
  facilement extensible plus tard.

**Contenu de la vue.**
- En-tête : % de complétion (possédés / total MusicBrainz), écoutes
  last.fm cumulées (albums + morceaux isolés de cet artiste), note
  moyenne perso, genres taggés, + bouton direct vers "Artistes similaires"
  pour cet artiste (préremplit le filtre existant)
- Liste chronologique de tous les albums/EP MusicBrainz : possédés
  (badge ✅, cliquable → ouvre la fiche, note perso + RYM + écoutes) et
  manquants (badge ⬜, note RYM/écoutes affichées si connues même sans
  être possédé, badge 🎯 si déjà en wishlist)

## v2026.07.12-15 — 🐛 Correctif majeur : cache local systématiquement non écrit

Signalé par Antoine via un dump console ("Cache local non écrit — quota
probablement dépassé" répété des dizaines de fois sur une session).

**Root cause, chiffrée.** Le cache `lastfm_tracks` (197 247 morceaux chez
Antoine) pesait à lui seul environ **9,6 Mo** une fois sérialisé en tuples
JSON compacts — au-dessus du quota localStorage typique (5-10 Mo,
**partagé** avec le reste des données de l'app). Aggravant : ce cache et
le cache principal (`LS_KEY` — albums+tracks+etc, ~3 Mo) étaient écrits
dans un seul et même `try/catch` — un dépassement de quota sur l'un
empêchait même la tentative des deux autres écritures
(`discotheque_lastfm`, `discotheque_rym`), qui auraient pourtant
probablement réussi seules.

**Conséquence réelle, au-delà du warning console.** L'optimisation d'egress
de juillet (`sync_state.version`, v2026.07.10-33 — celle qui évite de
retélécharger toute la collection à chaque ouverture) ne jouait plus son
rôle pour `lastfm_tracks` : rechargement complet silencieux depuis
Supabase à chaque session, le problème d'egress d'origine qui était censé
être réglé.

**Correctifs.**
1. `writeLastfmTracksCache()` sérialise désormais en une seule string
   délimitée par un caractère de contrôle (`\x1f`) plutôt qu'un tableau de
   tuples JSON — plus compact (l'ampleur du gain dépend de la distribution
   réelle des écoutes). Si le quota est quand même dépassé, retente
   automatiquement avec un seuil d'écoutes minimum croissant
   (0 → 1 → 2 → 3 → 5 écoutes) plutôt que d'abandonner tout le cache d'un
   coup — garde les morceaux les plus écoutés (les plus utiles pour
   "Manquants — Morceaux" et Session notation, déjà triés par écoutes).
2. `writeLocalCache()` : chaque clé (`LS_KEY`, `discotheque_lastfm`,
   `discotheque_rym`) a maintenant son propre `try/catch` — un échec sur
   l'une n'empêche plus les deux autres.
3. `discotheque_lastfm`/`discotheque_rym` servis aussi au format délimité.

Les 3 loaders correspondants sont mis à jour en conséquence, avec un repli
de lecture sur l'ancien format JSON le temps de la transition (se
réécrit tout seul au prochain `saveToStorage()`, aucune action manuelle
nécessaire).

## v2026.07.12-14 — Le verrou 🔒 tient désormais face au réimport MusicBee (genre, artiste)

Demandé par Antoine, suite à une discussion sur la fiabilité du Nettoyage
des genres/artistes : "je ne suis pas maître dans MB ou Discogs car ce sont
des synchros avec leurs BDD" — corriger le tag à la source n'est pas une
option praticable pour lui.

**Le problème.** MusicBee écrasait `genre` et `artist` sans condition à
chaque réimport, **même si le champ était verrouillé** — la seule exception
au principe général "un champ verrouillé n'est plus jamais écrasé par une
source auto". Résultat concret : une fusion faite dans le Nettoyage des
genres ou des artistes (ex. "rock" → "Rock") était silencieusement annulée
dès le réimport MusicBee suivant, tant que le tag MusicBee lui-même n'était
pas corrigé — ce qu'Antoine ne peut pas faire, MusicBee/Discogs étant de
simples synchronisations avec leurs propres bases.

**Le correctif.**
- **Genre** : le réimport XML principal (`importMusicBeeXML`) respecte
  désormais le verrou (`!isManualField(existing, 'genre')`). L'import M3U
  le respectait déjà.
- **Artiste** : ajouté au système de provenance générique (n'était pas
  encore un champ suivi) + même garde dans `importMusicBeeXML`, en plus de
  la protection déjà existante pour les albums avec `discogsId` (Discogs
  fait autorité sur l'artiste dans ce cas).
- **`mergeGenreCluster()`/`mergeArtistCluster()`** (Nettoyage des
  genres/artistes) **verrouillent désormais automatiquement** tous les
  albums du groupe fusionné — la fusion tient donc dès le premier clic,
  sans avoir à aller verrouiller chaque fiche une par une après coup.

**Revers du compromis** (indiqué dans les 2 modales) : si un jour le tag
est vraiment corrigé côté MusicBee ou Discogs, il faudra déverrouiller
manuellement (🔒→🔓 dans le panneau "Provenance des champs" de la fiche)
pour que la nouvelle valeur soit reprise — sinon l'ancienne valeur
verrouillée continuera de gagner indéfiniment.

## v2026.07.12-13 — Simplification du calcul de la note perso depuis MusicBee

Demandé par Antoine, suite à une question sur le mécanisme derrière
`album.note` (import MusicBee).

**Avant.** Le tag "Album Rating" est exporté par MusicBee au niveau de
chaque piste (pas un vrai champ album). Pour absorber le cas où les pistes
d'un même album auraient des valeurs désynchronisées, le code agrégeait par
**fréquence** : la valeur la plus courante parmi toutes les pistes de
l'album l'emportait. Problème signalé : en cas d'égalité de fréquence entre
deux valeurs, le départage dépendait de l'ordre d'itération de
`Object.entries()`, pas prévisible depuis l'interface.

**Après.** Prend directement le **premier** tag "Album Rating" non nul
rencontré parmi les pistes de l'album, sans agrégation. "Album Rating" est
déjà censé être identique sur toutes les pistes d'un album correctement
synchronisé dans MusicBee — la fréquence n'apportait rien de fiable en
pratique, seulement de l'indirection. `albumRatingCounts` (plus utilisé
nulle part) supprimé.

**Impact.** Aucun changement quand toutes les pistes d'un album partagent
déjà la même note (cas normal, la grande majorité) — seul le cas
désynchronisé change de comportement, et son résultat était de toute façon
imprévisible avant ce correctif.

## v2026.07.12-12 — Fusion "Prochain à écouter" → Session notation, ordre aléatoire

Demandé par Antoine, suite à une discussion sur le tri par écoutes de
Session notation (qui reléguait structurellement les albums/morceaux
jamais écoutés en toute fin de file).

**Suppression de l'onglet "🎧 Prochain à écouter"** (v2026.07.10-17) —
intégralement : nav sidebar, section HTML, entrée dans `SECTIONS`,
titres/sous-titres, et tout le code JS associé
(`buildNextToListenQueue`, `renderNextToListen`, `initNextToListen`,
`ntSkipCurrent`, `_nextToListenRym`, `NEXTTRACK_WISH_PRIO_BONUS`,
`NEXTTRACK_PRIO_LABEL`).

**Ordre aléatoire dans Session notation** (albums et morceaux isolés).
`buildRatingQueue()`/`buildRatingQueueTracks()` ne trient plus par écoutes
last.fm décroissantes — nouveau helper générique `shuffleArray()`
(Fisher-Yates). Les albums/morceaux jamais écoutés étaient déjà dans cette
file (tout élément possédé non noté y entre, indépendamment du nombre
d'écoutes) : seul l'ancien tri les enterrait systématiquement en dernière
position, donc le rôle de "Prochain à écouter" (leur donner une visibilité)
est repris naturellement, sans logique de fusion supplémentaire à écrire.

La wishlist n'a jamais fait partie de cette file et n'y entre toujours
pas — Session notation ne note que des éléments **possédés**, contrairement
à l'ancien "Prochain à écouter" qui mélangeait possédés et wishlist.

La file est recalculée (donc re-mélangée) à chaque ouverture de l'onglet.

## v2026.07.12-11 — Actions de masse sur "last.fm — Morceaux"

Demandé par Antoine. Jusqu'ici, les actions 🚫 Ignorer / 🎯 Wishlist /
＋ Ajouter aux morceaux isolés ne s'appliquaient qu'à une ligne à la fois —
fastidieux sur une longue liste de morceaux écoutés jamais nettoyée depuis
l'import last.fm.

Même moule que la sélection multiple déjà en place sur l'onglet Albums
(`selectedAlbumIds`/`renderBulkActionsBar`), avec une différence de clé :
la sélection utilise `normalizeKey(artiste, titre)` plutôt qu'un id ou un
index de ligne. `computeMissingTracks()` reconstruit sa liste à chaque
appel (pas d'id stable), et une clé texte survit à un changement de
filtre/tri entre deux sélections — un index de ligne redeviendrait invalide
dès qu'on retrie ou refiltre.

**Nouveautés** : case à cocher par ligne, "sélectionner tout (page
courante)" dans l'en-tête, et une barre d'actions avec compteur :
- 🚫 Ignorer (bascule — ré-appliquer sur un morceau déjà ignoré le
  retire, même sémantique que le bouton individuel existant)
- 🎯 Wishlist (ajoute à la wishlist morceaux, idem)
- ＋ Ajouter aux morceaux isolés
- Annuler la sélection

L'action 🔗 Associer reste volontairement individuelle (modale de choix
par morceau, pas batchable en pratique), comme la recherche YouTube Music.

## v2026.07.12-10 — Export offline étendu : entrées RYM/last.fm hors collection

Demandé par Antoine. L'export offline Android (fichier HTML autonome,
consultable sans connexion) incluait jusqu'ici uniquement les albums
possédés. Il inclut désormais aussi les albums **notés sur RYM ou
scrobblés sur last.fm mais absents de la collection**, avec un flag
`outOfCollection` par entrée.

**Nouvelle fonction `computeOutOfCollectionEntries()`.** Fusionne deux
sources déjà existantes en une seule liste par artiste+album (un album peut
être à la fois noté sur RYM et scrobblé sur last.fm sans être possédé) :
- RYM : même logique d'ownership que `computeRYMMissing()` (onglet ⭐ RYM),
  mais **sans le seuil de note** — l'export est un inventaire de référence,
  pas une liste d'action à trier, donc pas de raison d'en cacher une partie
- last.fm : réutilise directement `computeMissing()` (onglet Manquants)

Aucune nouvelle définition d'"possédé" créée — réutilise
`getOwnedRymKeys()`/`rymAssociations` déjà établis ailleurs dans l'app.

**Template HTML autonome.** Nouveau filtre "Tous / En collection / Hors
collection", badge "🔭 Hors collection" + bordure en pointillés sur les
cartes concernées.

**Notes DC/MB/RYM par entrée.** Déjà affichées pour les albums possédés
(badges existants, inchangé). Pour les entrées hors collection : DC
(Discogs) et MB (MusicBee) restent vides — logique, pas d'album possédé
signifie pas de note perso Discogs ni MusicBee — seules RYM (note perso
RYM) et les écoutes last.fm peuvent être renseignées selon la source.

## v2026.07.12-09 — 🐛 Correctif : badge "Stock" fantôme après déplacement vers Ok

Signalé par Antoine, diagnostiqué via un dump console de 2 albums Electrelane
/ Elysian Fields — 2 cas distincts confirmés dans les données.

**Cas 1 — vrai bug applicatif, corrigé.** `primaryFolder` était une valeur
"sticky" : mis à `'stock'` dès qu'un album matchait le stock de l'export
courant (`ex.primaryFolder = 'stock'`), mais **jamais recalculé** quand
l'album sortait du stock. `folders[]` se corrigeait bien (grâce au
correctif v2026.07.12-07), mais `primaryFolder` restait figé sur `'stock'`
indéfiniment — exactement ce que teste `isStock` dans `renderAlbums()` en
repli `|| a.primaryFolder === 'stock'`, d'où le badge "📦 Stock" fantôme
même quand `folders` ne contenait plus que `['ok']`.

Nouveau helper `derivePrimaryFolder(folders)` (hiérarchie `discographie` >
`forsale` > `ok` > `stock` > `album`, `'ok'` prime volontairement sur
`'stock'`), appelé sur **tous** les albums en une seule passe après que
`folders[]` a fini de bouger dans `importMusicBeeXML()` (boucle
principale + nettoyage des orphelins + réconciliation stock) — remplace
les 3 affectations ad hoc `primaryFolder = 'stock'` qui posaient problème.

**Cas 2 — pas un bug, donnée fidèle.** Pour un album comme "The Power Out",
le dump montrait `folders: ['ok', 'stock']` — les **deux** flags
réellement présents en même temps, pas un résidu. Ça veut dire que
MusicBee expose encore un fichier de cet album sous le chemin Stock en
plus de sa copie dans Ok (déplacement incomplet côté bibliothèque
MusicBee — ancien fichier non supprimé, ou déplacement partiel). L'app
reflète fidèlement les deux emplacements ; le nettoyage doit se faire côté
MusicBee (vérifier qu'il ne reste pas de copie sous `!_00_stock/...` pour
cet album).

## v2026.07.12-08 — Filtre "Wishlist" dans l'onglet Albums

Demandé par Antoine. Nouveau sélecteur dans la barre de filtres de la
collection (onglet Albums) : Tous / 🎯 En wishlist / Pas en wishlist.

Correspondance **exacte** artiste+album (`normalizeKey`), même logique que
`wishlistOwnedSet()`/`pruneWishlistOwned()` — pas de correspondance floue
par `artistVariants()`, pour éviter qu'un faux-positif masque une entrée
légitime.

Usage principal anticipé : repérer les albums encore listés en wishlist
alors qu'ils sont déjà en collection. C'est normal dans un cas précis et pas
un bug à corriger : seul Discogs déclenche le retrait automatique de la
wishlist (`wishlistOwnedSet()`) — un album seulement en Stock (fichiers
présents mais pas encore reporté dans Discogs) reste donc légitimement en
wishlist jusqu'à son ajout à Discogs.

Ajouté à `FILTER_PRESET_VIEWS.collection.fields` pour que les préréglages
de filtres existants sauvegardent/restaurent aussi ce nouveau filtre.

## v2026.07.12-07 — 🐛 Correctif majeur : "Ok" figé après retag MusicBee + réimport

Signalé par Antoine (capture d'écran) : 2 audiobooks retagués dans MusicBee
puis réimportés (XML à jour) restaient marqués "✅ Ok" alors qu'ils
n'appartiennent plus à ce dossier.

**Cause.** `importMusicBeeXML()` ne mettait à jour les flags `'ok'` /
`'discographie'` d'un album que s'il était retrouvé dans l'export XML
courant (boucle `Object.values(grouped).forEach`). Un album absent de
l'export courant — retagué de façon à sortir du scope exporté, déplacé,
supprimé du disque — n'était **jamais touché** par l'import : ses flags du
dernier import où il apparaissait restaient figés indéfiniment, peu importe
le nombre de réimports suivants.

**Correctif.** Nouveau `touchedAlbumIds` (`Set`) qui trace tous les albums
confirmés présents dans l'export XML en cours de traitement. Une fois la
boucle d'import terminée, tout album ayant encore `'ok'`/`'discographie'`
dans `folders[]` mais absent de `touchedAlbumIds` se voit retirer ces 2
flags — jamais `'forsale'` (volontairement persistant d'un import à
l'autre, comportement existant inchangé) ni `'stock'` (réconcilié
séparément via `stockAlbums`).

**Effet de bord bénéfique.** Ce correctif débloque aussi la détection de
`ghostAlbums` déjà présente plus loin dans la même fonction (albums sans
plus aucun support après import, proposés à la suppression via `confirm()`)
— celle-ci excluait explicitly `a.okFolder === true` de ses candidats, donc
un album coincé en "Ok" à tort n'était jamais proposé à la suppression non
plus. Les 2 audiobooks d'Antoine seront donc désormais correctement
proposés à la suppression (jamais automatique) au prochain réimport, s'ils
n'ont effectivement plus aucun support dans la collection.

## v2026.07.12-06 — 9 nouveaux blocs "gratuits" dans Insights

Suite à une revue des améliorations possibles pour l'onglet Insights, tri par
Antoine sur celles ne nécessitant ni appel last.fm supplémentaire ni migration
SQL — tout ce qui suit est calculé à partir de données déjà en mémoire.

**2 nouvelles cartes stats** (2e ligne, sous les 4 cartes existantes) :
- Complétude moyenne des fiches (réutilise `COMPLETENESS_CRITERIA` de
  l'onglet Complétude)
- Écart moyen note perso / RYM (positif = tu notes plus généreusement que
  RYM en moyenne — complète la liste détaillée déjà dans Audit collection)
- Série d'écoute en cours / record, calculée sur la heatmap 90 jours déjà
  chargée (zéro appel last.fm en plus — affiche "–" tant que la heatmap n'a
  jamais été chargée une première fois)
- Résumé Wishlist par priorité (🔴🟡🟢)

**Nouvelle section "📀 Composition de la collection"** :
- Support (Discographie / Ok / Stock / Vendre — réutilise `_journalFolderLabel()`
  du Journal des changements)
- Format numérique (FLAC / MP3 / digital / CD sans fichier numérique)
- Top 10 labels
- Albums studio vs compilations (`isCompilation`)
- Provenance des données : barres empilées manuel / auto (Discogs,
  MusicBrainz) / import direct (MusicBee XML, Discogs CSV) / vide, sur les
  4 champs suivis par le système de provenance existant (v2026.07.10-01) —
  un "data health" visuel en un coup d'œil, différent de l'onglet Audit qui
  corrige des divergences plutôt qu'il n'en mesure les proportions.

**Nouvelle section "⭐ Notes & goût"** :
- Distribution des notes perso (histogramme par demi-étoile, au lieu de
  juste la moyenne affichée jusqu'ici)
- Écoutes moyennes par tranche de note perso (`lastfmData` déjà chargé, un
  index `Map` construit une seule fois par calcul pour éviter un `.find()`
  linéaire par album sur toute la collection)
- Top genres × décennies : matrice compacte (6 genres les plus représentés),
  réutilise `originalYearOf()` introduit en v2026.07.12-05

## v2026.07.12-05 — 🐛 Correctif : "Décennies" (Insights) utilisait l'année du pressage

Signalé par Antoine en questionnant l'écran Insights : le bloc "📅 Décennies"
regroupait les albums par `album.year`, qui est l'année du **pressage/édition
en collection** (MusicBee ou Discogs CSV) — pas forcément l'année de 1re
parution de l'album. Un vinyle réédité en 2015 d'un disque de 1975 comptait
donc dans les années 2010.

L'app avait déjà de quoi corriger ça : `mb_original_year` (MusicBrainz,
v2026.07.06-5) et `discogs_master_year` (master release Discogs,
v2026.07.10-10) existent précisément pour distinguer les deux, déjà utilisés
pour le badge `(orig. XXXX)` sur les fiches — juste jamais branchés sur ce
calcul-là. Nouveau helper `originalYearOf(a)` : priorité
`mb_original_year` → `discogs_master_year` → repli sur `year` si aucune des
deux sources n'est disponible pour cet album. Tooltip ajouté sur le titre de
la carte pour expliciter la source utilisée à l'affichage.

## v2026.07.12-04 — 📈 Historique de valeur collection

Todo section 11, dernier item ⬜ : "Valeur collection" (v2026.07.10-24) est un
instantané figé — conserver un point de valeur par mois donnerait une vraie
courbe d'évolution.

Nouveau bloc "📈 Historique de valeur" en haut de l'onglet Valeur collection.
`recordMarketValueSnapshot()` prend une photo des prix **déjà estimés**
(`marketplace_price`) à chaque visite de l'onglet — aucun appel réseau,
contrairement à "🔄 Estimer les prix manquants" qui va chercher les prix
eux-mêmes. Un seul point par mois : si un point existe déjà pour le mois en
cours, il est simplement écrasé avec la valeur à jour (comme demandé, pas
besoin de plus qu'un point/mois).

⚠️ Avertissement affiché sous le graphique : une hausse d'un mois à l'autre
peut simplement venir de plus de CD estimés depuis la dernière visite, pas
forcément d'une vraie hausse de cote Discogs.

Nouvelle variable `marketValueHistory`, persistée exactement comme
`listeningEvolution` (meta.market_value_history_data côté Supabase + cache
local egress) — aucune colonne Supabase supplémentaire, aucune migration
SQL nécessaire, tout tient dans le `meta` JSON générique déjà en place.

Todo section 11 intégralement traitée, à l'exception du glisser-déposer de
pochette (toujours bloqué sur la décision de stockage binaire, hors scope
de cette session).

## v2026.07.12-03 — 🎼 Évolution du goût + 📅 "Ce jour-là"

Todo section 11, 2 items ⬜.

**Évolution du goût dans le temps.** Le dashboard Insights montrait une
répartition genres/décennies figée à aujourd'hui. Nouveau bloc "🎼 Évolution
du goût (genres)", calculé **dans la même boucle** que
`loadListeningEvolution()` (v2026.07.10-14) — chaque semaine des weekly
charts last.fm donnait déjà un total d'écoutes par artiste ; il suffisait de
retrouver le genre de chaque artiste (via les albums possédés,
`artistVariants()`) pour ventiler ce même total par genre en plus du total
mensuel déjà calculé. **Zéro appel réseau supplémentaire.** Pas de vraie
série temporelle (pas de lib de graphique dans l'app, un multi-lignes 12
genres × 24 mois serait de toute façon illisible en barres) : comparaison
des 12 derniers mois vs les 12 précédents, triée par plus gros mouvement
absolu — répond directement à l'exemple de la todo ("plus de jazz cette
année qu'il y a deux ans") dans la limite des 24 mois chargés. Nouvelle
variable `genreEvolution`, persistée comme `listeningEvolution`.

**"Ce jour-là".** Nouveau bloc en haut de l'onglet Insights, 2 volets de
coût très différent : 🎂 anniversaires de sortie aujourd'hui — 100% côté
client, à partir de `album.release_date` (déjà rempli par les
enrichissements Discogs/MusicBrainz existants quand la source donne une
date complète jour/mois — donc couverture partielle par nature, beaucoup
d'albums n'auront jamais de date au jour près) ; 🕰️ écoutes ce même jour
les années passées — à la demande (bouton), 1 appel last.fm par année en
arrière borné à ce jour calendaire précis (`from=`/`to=`), jamais persisté
puisque le résultat se périme de toute façon dès le lendemain.

## v2026.07.12-02 — 🔎 Nouvel onglet "Audit collection"

Regroupe 4 items ⬜ de la todo qui partagent le même besoin : une vue d'ensemble
pour corriger en série, là où l'outil existant ne fonctionnait qu'une fiche à
la fois.

**1. Scores MusicBrainz bas** (todo section 6). `album.mb_match_score`
(v2026.07.07-12) était déjà calculé par album mais seulement visible en
ouvrant chaque fiche. Nouveau tri global croissant, 100% côté client (aucun
appel réseau), pour repérer directement les matches douteux (< 95%).

**2. Notes perso vs RYM très divergentes** (todo section 1). Liste les
albums où l'écart entre `album.note` et le rating RYM associé
(`lookupRym()`) est ≥ 1.5★. Purement informatif — jamais de note modifiée
automatiquement, comme demandé (peut signaler soit une mauvaise association
RYM à vérifier, soit un simple désaccord de goût). 100% côté client.

**3. Divergences Discogs / MusicBrainz — vue globale** (todo section 1). Le
panneau par-fiche "🔍 Comparaison Discogs/MusicBrainz" (v2026.07.10-05)
n'était peuplé qu'au clic sur "Rafraîchir depuis la source" d'UNE fiche
ouverte. Nouveau bouton "🔍 Scanner les divergences" qui rejoue
`fetchDiscogsRelease`/`fetchMusicBrainzRelease` pour tous les albums ayant
les deux IDs liés (pacé ~800ms entre albums + 700ms entre les deux sources
d'un même album, même cadence que `fetchAllMarketplaceStats`). Résultat non
persisté (comme `_sourceCmpCache` existant, qu'il alimente au passage) —
lecture seule dans la liste, ouvrir la fiche pour appliquer une valeur via
le mécanisme "↳ Appliquer" déjà en place.

**4. Complétion de discographie — vue globale** (todo section 11).
"Discographie manquante" (v2026.07.10-23) fonctionnait artiste par artiste
depuis la fiche album. Nouveau bouton "🔍 Scanner la discographie" qui
rejoue les mêmes 2 requêtes MusicBrainz publiques (artist puis
release-group) pour tous les artistes possédés (CD catalogué Discogs
requis, même définition d'ownership que la wishlist), pacées ~1.1s chacune
(limite non-authentifiée MusicBrainz ~1 req/s). Résultats triés par % de
complétion croissant (pires trous en premier), bouton "⏹ Arrêter"
disponible en cours de route — le temps estimé est affiché avant de
lancer, ça peut être long sur une grosse collection (~2,2s/artiste).

Les 2 scans en masse sont volontairement à la demande, jamais automatiques
ni persistés — diagnostic ponctuel, pas une donnée de collection à
synchroniser.

## v2026.07.12-01 — 🧬 Nettoyage de taxonomie artiste

Todo section 1, item ⬜ : des variantes comme "The Beatles" / "Beatles, The"
/ "Beatles" fragmentent silencieusement les stats et filtres par artiste
sans qu'aucun outil ne le détecte à l'échelle de la collection.

Même moule que le nettoyage de genre (v2026.07.10-31) : union-find sur les
artistes distincts de la collection, jamais de fusion automatique, réutilise
`snapshotForUndo()` pour l'historique annulable. Un 3e critère de
regroupement s'ajoute par rapport au genre — `normArtistCore()` résout
l'inversion d'article ("Beatles, The" ↔ "The Beatles"), la variante la plus
fréquente côté artiste et sans équivalent côté genre. Seuils de distance de
Levenshtein légèrement plus prudents que pour le genre (noms d'artiste
généralement plus longs, faux positif plus coûteux entre deux artistes
réellement distincts).

Nouvelle modale "🧬 Nettoyage des artistes" (groupes de variantes, choix du
libellé canonique par radio, "🔧 Fusionner" / "✕ Ignorer" par groupe),
accessible depuis le diagnostic d'intégrité et depuis le nouvel onglet
Audit collection (v2026.07.12-02). Scope volontairement limité à
`album.artist`, comme demandé — `tracks[]`/`wishlist[]` portent aussi un
champ artist mais ne sont pas couverts, même choix de périmètre que le
nettoyage de genre qui ne touche que `album.genre`. Aucune colonne Supabase
supplémentaire.

## v2026.07.10-33 — 🐛 Correctif majeur : dépassement d'egress Supabase

Signalé par Antoine : quota gratuit Supabase à 134% (6,685 / 5 Go d'egress),
alors que la base de données elle-même ne faisait que 48% de son quota
(500 Mo) — deux limites indépendantes, deux causes différentes.

**Diagnostic.** Aucun cache local n'était écrit tant que Supabase était
configuré — `_saveToStorageImpl()` n'écrivait dans localStorage que dans la
branche "pas de Supabase". Résultat : chaque ouverture de l'app, sur chaque
appareil et chaque onglet, retéléchargeait *intégralement* albums +
`lastfm_data` (38 000 lignes) + `lastfm_tracks` (116 000 lignes) depuis
zéro — même quand rien n'avait changé depuis la veille. C'est ce
rechargement systématique, pas la taille réelle des données, qui expliquait
le dépassement.

**Correctif.** Réutilise `sync_state.version` (déjà en place pour la
détection de conflit multi-onglets) : `connectSupabase()` compare
désormais, via un appel léger (`fetchSyncState()`, une seule ligne), la
version distante à la dernière version chargée avec succès par *ce*
navigateur — persistée en localStorage (`LS_SYNC_VERSION_CACHE`),
contrairement à `_localSyncVersion` qui ne survivait pas à un rechargement
de page.

- **Version identique** → cache local servi directement
  (`loadFromStorage()` + nouveau `loadLastfmTracksFromLocalStorage()`),
  egress quasi nul sur les deux plus grosses tables.
- **Version différente** (ou premier lancement) → rechargement réseau
  complet, comme avant.

Nouvelles fonctions `writeLocalCache()` / `writeLastfmTracksCache()`
(format compact en tuples pour `lastfm_tracks`), appelées après chaque save
*et* chaque load réussi. Écriture protégée par `try/catch` dédié — en cas
de quota localStorage dépassé (5-10 Mo selon navigateur), dégradation
gracieuse vers un rechargement complet au lancement suivant, jamais de
blocage.

**Portée volontairement limitée** à `lastfm_data`/`lastfm_tracks` (~154 000
lignes, l'essentiel du volume) pour cette première passe —
`album_tracks`/`musicbee_tracks` (tracklists, détection "morceaux
manquants") restent rechargés à chaque ouverture même dans la branche cache
local (coût modeste en comparaison) — à mettre en cache aussi si l'egress
reste élevé après ce correctif.

## v2026.07.10-32 — 📱 Nouveau : PWA installable

Todo section 11, dernier item ⬜ (*« manifest + service worker minimal pour
un accès mobile plus fluide que l'export HTML offline actuel, sans refonte
d'architecture »*). L'Export M3U (item voisin) a été écarté à la demande
d'Antoine — l'app ne persiste le chemin de fichier local d'aucune piste
(principe agrégateur sans binaire), donc un M3U pointant vers de vrais
fichiers n'était pas possible sans changement de schéma plus lourd.

**3 nouveaux fichiers à déployer** : `manifest.json`, `icon-192.png`,
`icon-512.png`, `icon-512-maskable.png` (icônes générées aux couleurs du
thème — fond `--bg`, disque `--accent`), et `sw.js` (service worker).

**Portée volontairement réduite** au shell statique (HTML/CSS/JS/icônes,
stratégie stale-while-revalidate). Aucune requête Supabase ou API externe
n'est interceptée — servir une réponse Supabase mise en cache serait pire
que ne rien servir du tout (données périmées présentées comme à jour). Pas
d'offline complet : l'export HTML autonome existant reste la solution pour
une consultation 100% déconnectée. Ici, juste un chargement plus rapide et
une installation possible (icône sur l'écran d'accueil mobile, mode
standalone sans barre d'adresse).

⚠️ `CACHE_VERSION` dans `sw.js` à incrémenter à **chaque déploiement** (même
convention manuelle que `APP_VERSION`), sinon les visiteurs restent bloqués
sur le shell mis en cache précédemment. Enregistrement du service worker en
fin de `app.js`, chemin relatif (compatible sous-chemin GitHub Pages), échec
non bloquant.

## v2026.07.10-31 — 🧬 Nouveau : nettoyage de taxonomie genre

Todo section 11 (*« détection de variantes proches (casse, espaces,
quasi-doublons) avec fusion assistée — dans l'esprit du diagnostic
d'intégrité existant »*).

**Détection** (`computeGenreClusters()`, 100% client) : regroupe les genres
distincts de la collection par union-find sur 3 critères cumulés —

1. égalité casse/espaces (fusion évidente, ex. "Rock" / "rock ")
2. égalité une fois la ponctuation retirée (ex. "Hip Hop" / "Hip-Hop" /
   "HipHop")
3. distance de Levenshtein tolérée proportionnelle à la longueur, avec un
   seuil de longueur minimale (5 caractères) pour éviter de rapprocher des
   genres courts sans rapport (ex. "IDM" / "EDM" ne doivent pas fusionner)

**Fusion.** Jamais automatique — nouvelle modale "🧬 Nettoyage des genres"
(accessible depuis 🩺 Diagnostic d'intégrité) : chaque groupe de variantes
affiche le nombre d'albums concernés, un choix du libellé canonique par
bouton radio, un bouton "Fusionner" et un "✕ Ignorer" (le temps de la
session — pour les cas où deux genres proches sont volontairement
distincts).

Réutilise `snapshotForUndo()` / `integrityLog` existants — les fusions
apparaissent dans le même historique annulable que le diagnostic
d'intégrité, pas de système d'annulation dédié. Aucune colonne Supabase
supplémentaire (réécrit `album.genre`, déjà synchronisé).

## v2026.07.10-30 — 📤 Nouveau : suivi de prêts

Todo section 11, premier item ⬜ restant (*« Suivi de prêts : champ prêté à /
date sur les CD physiques + liste des prêts en cours »*).

**Migration requise** (`migration_v2026.07.10-30.sql`) : 2 nouvelles colonnes
`albums.loaned_to` / `albums.loaned_since` (text). **À déployer avant** le
nouveau front-end — ces champs font partie du même upsert que tous les
autres champs album, donc pas de dégradation gracieuse possible ici :
`saveToSupabase()` échouerait en totalité tant que la migration n'est pas
appliquée.

**Modale édition album.** Nouveau bloc "📤 Prêt" : prêté à + date + bouton
"↩ Marquer comme rendu" (vide les 2 champs, à sauvegarder comme le reste du
formulaire — annulable tant qu'on ne clique pas Enregistrer).

**Nouvel onglet "📤 Prêts en cours"** (nav Outils, badge sidebar). Tableau
des CD prêtés triés par date de prêt (plus anciens en premier), durée en
jours affichée à côté de la date, bouton "↩ Rendu" par ligne — celui-ci
sauvegarde immédiatement (pas de bouton "Enregistrer" séparé dans ce
tableau, contrairement à la modale).

Aucune détection automatique de retour (contrairement à Discogs/RYM dans
"Notes à reporter") : le prêt est une info purement locale à l'app, aucune
source externe ne la connaît.

## v2026.07.10-29 — 🐛 Correctif : snapshots auto en doublons (race condition)

Signalé par Antoine avec capture d'écran : 3 snapshots "Auto — avant
suppression de 17 album(s)" identiques, créés à 5-7 secondes d'intervalle.

**Cause.** Fenêtre de course dans `saveToSupabase()` : le verrou
`_savingToSupabase` n'était posé qu'*après* l'`await` de `fetchSyncState()`
(la détection de conflit multi-appareil), alors que le test précoce
`if (_savingToSupabase) return` est synchrone. Plusieurs appels
`saveToSupabase()` déclenchés à quelques millisecondes d'intervalle
(plusieurs actions coup sur coup, chacune passant par `saveToStorage()`)
passaient donc tous ce test pendant que le flag valait encore `false`, puis
exécutaient chacun — en parallèle — le diff destructeur (comparaison locale
vs remote → suppression des absents) sur le même état remote pas encore
modifié par les autres appels. Résultat : le même nombre d'albums "à
supprimer" détecté plusieurs fois, et un `autoSnapshotBeforeDelete()`
déclenché à chaque appel concurrent.

**Correctif.** `_savingToSupabase = true` posé immédiatement après le test
initial, avant tout `await`, fermant la fenêtre de course. Le cas "conflit
détecté" (retour anticipé, qui ne passe plus par le bloc `try/finally`
existant) réinitialise désormais le flag manuellement.

Les doublons déjà créés avant ce correctif ne sont pas nettoyés
automatiquement — suppression manuelle (🗑) recommandée dans la modale
Snapshots pour les entrées identiques.



Signalé par Antoine avec captures d'écran (Ali Farka Touré — *Voyageur* : 22
écoutes sur la page artiste last.fm et dans la fiche Collection, mais "–" en
Wishlist alors que l'album y figure aussi).

**Cause.** Même famille de bug que la note RYM absente en wishlist (corrigée
en v2026.07.10-02) : la colonne "Écoutes" de `renderWishlist()` affichait le
snapshot `w.plays` figé au moment de l'ajout à la wishlist, jamais rafraîchi
ensuite — ni par un import last.fm ultérieur, ni par le fait que l'album a
depuis rejoint la Collection avec ses propres écoutes réelles.
`exportWishlistCSV()` faisait déjà un lookup live via une `lfIndex` locale —
seul l'écran restait sur l'ancien comportement, d'où l'incohérence visible
entre Collection (à jour) et Wishlist (figée).

**Correctif.** Nouvelle fonction `wishPlays(w)`, même principe que
`wishRymEntry()` déjà en place : lookup live dans `lastfmData` par
`normalizeKey`, avec repli sur `cleanDiscogsArtist()` (comme les autres
lookups wishlist), puis sur `w.plays` si aucune correspondance last.fm
n'existe (ex. wishlist manuelle sans historique d'écoute). Utilisée dans
`renderWishlist()` (affichage), `wishFilteredList()` (le tri secondaire par
écoutes triait lui aussi sur le snapshot figé) et `exportWishlistCSV()`
(remplace la `lfIndex` dupliquée par le même helper commun — comportement
inchangé pour l'export, juste factorisé).

**Pourquoi ce fichier**, en plus du commentaire inline ? Le commentaire `APP_VERSION`
n'est conservé que pour les dernières versions — les plus anciennes disparaissent au fil
des éditions successives du fichier. Ce fichier, lui, accumule tout : c'est la mémoire
longue durée du projet.

**Processus à partir de maintenant** : chaque bump de version continue de mettre à jour
le commentaire `APP_VERSION` (tête du fichier) **et** le badge visible (`#app-version`,
topbar) comme avant — *plus* une entrée ajoutée en tête de ce fichier, avec le même texte
que le commentaire inline. Les versions antérieures à la création de ce fichier
(≤ v2026.07.09-02) ont été reconstituées a posteriori à partir des commentaires encore
présents dans `index.html` et du suivi dans `ameliorations-collection.md` — le détail y
est donc plus condensé que pour les entrées futures.

Format : le plus récent en premier. Chaque entrée reprend le numéro de version, une ligne
de résumé, et le détail quand il est disponible.

---

## v2026.07.10-27 — 2 correctifs "Notes à reporter"

Signalés par Antoine avec capture d'écran (7 albums bloqués sur la cible MusicBee).

**(1) MusicBee n'est plus une cible pour les albums sans tracklist MusicBee.** Cas des albums
notés (Session notation/Stock) mais jamais destinés à rejoindre la collection MusicBee —
demander de "reporter dans MusicBee" un album qui n'y a aucun fichier n'avait pas de sens,
l'entrée restait bloquée indéfiniment.

Effet indirect exactement demandé par Antoine (*« quand la notation RYM est faite on peut
sortir de la note à reporter »*) : pour ces albums, une fois RYM satisfait, il ne reste plus
aucune cible → l'entrée disparaît automatiquement de la liste.

**(2) Le matching RYM prend en compte les associations manuelles.** `queueNoteToReport()` et
`pruneNotesToReport()` transmettent désormais l'id de l'album à `lookupRym()` (même correctif
que -26) — corrige le cas où le nom diffère légèrement entre la collection et RYM (1re entrée
de la capture, Nancy Sinatra) et empêchait la détection automatique même après association
manuelle.

Rétro-compatible : les entrées déjà existantes (sans id d'album stocké) sont rétro-remplies
automatiquement au premier passage — aucune perte, aucune migration nécessaire.

## v2026.07.10-26 — 🐛 Bug corrigé : la suggestion RYM restait invisible en Session notation après association manuelle

Signalé par Antoine avec captures d'écran (album VV Brown / *Travelling Like the Light*).

**Symptôme.** Après association manuelle RYM sur un album (nom trop différent pour un
matching automatique — ici "VV Brown" côté collection vs "V.V. Brown" côté RYM), la note RYM
se répercutait bien dans la Collection (colonne Note RYM), mais la "Suggestion RYM" affichée
en Session notation restait invisible pour ce même album — donnant l'impression d'une
réinitialisation au réimport MusicBee/RYM.

**Cause réelle**, sans lien avec un réimport : `lookupRym(artist, album, albumId)` sait déjà
retomber sur une association RYM manuelle via son 3e paramètre optionnel `albumId` quand le
matching par nom échoue — mais l'appel dans `renderRatingSession()` (Session notation)
omettait ce 3e argument, empêchant structurellement ce fallback de se déclencher, quelle que
soit l'association déjà faite. `rymAssociations` lui-même n'est jamais réinitialisé par un
réimport MusicBee ou RYM (vérifié : seul un `clearAll()` explicite, confirmation requise, le
vide).

**Correctif.** `albumId` ajouté à l'appel manquant dans `renderRatingSession()`, + 3 autres
call sites du même type de gap trouvés par audit (`addToWishlistFromAlbumId`,
`addToWishlistFromStock`, `queueNoteToReport`) — tous avaient un id d'album disponible en
contexte mais ne le transmettaient pas à `lookupRym()`.

## v2026.07.10-25 — Filtres sur l'onglet RYM

À la demande d'Antoine (hors todo).

L'écran ⭐ RYM n'avait jusqu'ici aucun filtre propre : seuls la recherche globale et le seuil
de note (qui ne s'appliquait qu'à la liste "Notés — absents") permettaient de restreindre les
4 listes de l'écran.

Ajout d'une vraie barre de filtres locale, même modèle que Wishlist/Collection : **Artiste**
(texte), **Album** (texte), **Genre** (select peuplé dynamiquement depuis les données RYM,
distinct des genres de la collection), **Année** (texte, préfixe). Appliqués aux 4 listes
(Notés absents / Non notés / Ownership introuvable / Non associés), en plus de la recherche
globale existante. Bouton ↺ Réinitialiser.

Intégré au système de préréglages de filtres existant (💾 enregistrer / ✕ supprimer, même
mécanisme que Collection/Discographie/Stock/Wishlist).

## v2026.07.10-24 — Valeur collection (stats marketplace Discogs)

Todo section 11, dernier item restant.

Contrairement à Discographie manquante (MusicBrainz, public, direct depuis le navigateur),
l'API marketplace Discogs nécessite le même token que tous les autres appels Discogs de
l'app → passe par l'**Edge Function `get-release-info.ts`**, mise à jour avec une nouvelle
branche `discogs_stats` (`GET /marketplace/stats/{release_id}?curr_abbr=EUR`, endpoint séparé
de `/releases/{id}`, retourne `lowest_price`/`currency`/`num_for_sale`) — diff strictement
additif, fichier complet fourni par Antoine puis renvoyé mis à jour.

**⚠️ Actions manuelles requises avant que la fonctionnalité marche :**
1. Exécuter `migration_v2026.07.10-24.sql` dans Supabase SQL Editor (4 nouvelles colonnes
   `albums` : `marketplace_price`, `marketplace_currency`, `marketplace_num_for_sale`,
   `marketplace_fetched_at`).
2. Redéployer `get-release-info.ts` : `supabase functions deploy get-release-info`.

Nouvel onglet **"💰 Valeur collection"** (nav Outils) : 4 cartes résumé (valeur totale
estimée, CD estimés/éligibles, en attente, prix moyen) + tableau trié par prix décroissant.
Périmètre : CD catalogués Discogs uniquement (`a.cd && a.discogsId`) — le numérique n'a pas
de valeur marketplace.

Bouton "🔄 Estimer les prix manquants" : boucle unique sur tout le périmètre restant en un
clic, pacée à 700ms entre requêtes (même cadence que `fetchAllTracklists`), jamais
automatique. Sauvegarde progressive tous les 10 albums pendant la boucle pour limiter la
perte en cas d'interruption.

## v2026.07.10-23 — Discographie manquante par artiste

Todo section 11, 6e et dernier item de la section.

Nouveau panneau **"🎼 Discographie manquante"** dans la fiche album (sous les crédits
MusicBrainz), bouton "🔍 Chercher sur MusicBrainz". Contrairement aux autres enrichissements MB
de l'app (tous via l'Edge Function `get-release-info`, non modifiable ici), interroge l'API
publique MusicBrainz directement depuis le navigateur — 2 requêtes séquentielles par clic,
jamais en masse/auto, conforme à la limite 1 req/s en usage non-authentifié.

Recherche l'artiste par nom, récupère ses release-groups album/EP, exclut les sorties
live/compilation/soundtrack/interview/spokenword/remix pour ne garder que le studio, compare
aux albums déjà possédés de cet artiste (toutes variantes de nom confondues). Résultat : liste
des absents avec année, bouton "+ Wishlist" par album (nouvelle source `discography`, ajoutée
au filtre/export/affichage wishlist) + bouton "+ Tout ajouter". Rien de persisté.

## v2026.07.10-22 — 🐛 3e bug : le Stock suffisait à vider la wishlist, alors que seul Discogs le doit

3e bug de la même investigation, confirmé par Antoine.

`pruneWishlistOwned()` traitait un album comme "possédé" (donc à retirer de la wishlist) dès
qu'il avait un fichier flac/mp3/cd/digital — y compris pour des albums **uniquement en Stock**
(fichiers MusicBee présents mais pas encore reportés dans Discogs/discographie).

Or le modèle de la wishlist est explicite : *"dans wishlist il n'y a que les albums non
présents dans discogs, c'est le contrôle discogs qui doit aboutir à leur retrait"* — le Stock
ne doit pas suffire à vider une entrée, seule la présence effective dans Discogs
(`a.discogsId`, posé par l'import CSV Discogs) doit le faire. C'est ce qui expliquait la
disparition des 32 entrées observées dans les logs (albums en Stock, pas en Discogs, déjà
retirés car ripés en flac).

**Correctif.** `wishlistOwnedSet()` vérifie désormais `a.discogsId` exclusivement, au lieu de
`(flac||mp3||digital||cd)`. Un album seulement en Stock reste en wishlist jusqu'à son passage
effectif par Discogs. `wishOwnedMatch()` (colonnes d'info "Note MB"/"Note DC", purement
informatif, aucune suppression) reste inchangé à dessein.

## v2026.07.10-21 — 🐛 2e bug critique : la protection anti-conflit n'a jamais fonctionné

Trouvé grâce aux logs console fournis par Antoine.

**Diagnostic.** Les requêtes GET/PATCH sur `sync_state?id=eq.1` renvoient systématiquement
406. Cause : le bump du compteur de version utilisait un `UPDATE .eq('id',1)` — la ligne
`id=1` n'a jamais été seedée (rien ne la crée), donc l'UPDATE affecte 0 ligne, et `.single()`
sur 0 ligne renvoie 406 côté PostgREST.

Le `catch` générique de `saveToSupabase()` interprétait cette erreur (ligne manquante) comme
"table absente" et positionnait `_syncTableMissing = true`, désactivant silencieusement toute
vérification de conflit pour le reste de la session — reproduit à **chaque sauvegarde** depuis
la mise en place de la fonctionnalité (v2026.07.09-01). Autrement dit : la détection de
conflit multi-onglets n'a jamais empêché un seul écrasement, malgré sa présence dans le code.

C'est très probablement la vraie cause-racine du vidage initial de la wishlist (34→1, avant
même le bug de restauration corrigé en -20) : un onglet resté ouvert avec une wishlist locale
obsolète a pu resauvegarder par-dessus la version à jour, sans qu'aucun garde-fou ne s'y oppose.

**Correctif.**
1. Le bump utilise désormais `.upsert({id:1,...}, {onConflict:'id'})` au lieu d'un UPDATE pur
   — la ligne se crée d'elle-même si absente, au lieu de faire échouer l'opération en silence.
2. Le `catch` de `saveToSupabase()` ne positionne plus `_syncTableMissing` sur une erreur
   générique (seul `fetchSyncState()` le fait, sur détection explicite de table réellement
   absente) — un `console.warn` diagnostique est émis à la place.
3. `fetchSyncState()` logue aussi un warning sur toute erreur inattendue, pour que ce genre de
   dégradation silencieuse reste visible dans les logs futurs.

⚠️ Auto-réparateur au prochain déploiement (la ligne se crée à la première sauvegarde), mais
la protection n'aura jamais été active *avant* — aucune conséquence rétroactive sur les
données déjà perdues.

## v2026.07.10-20 — 🐛 Bug critique corrigé : la wishlist se vidait après restauration d'un snapshot

**Symptôme signalé** : un snapshot contenant 33 entrées wishlist, mais la restauration ne les
ramenait pas — la wishlist restait quasi vide après coup.

**Cause.** `restoreSnapshot()` restaure la wishlist en mémoire puis appelle `updateNavBadges()`
*avant* d'attendre `saveToSupabase()`. Or `updateNavBadges()` déclenche `pruneWishlistOwned()`
de façon **débouncée à 80ms**, largement plus court que `saveToSupabase()` qui enchaîne
plusieurs allers-retours réseau (albums, purge des IDs distants absents, tracks) avant même
d'atteindre la sérialisation de la wishlist. Le prune débouncé se déclenchait donc *pendant*
l'upload, mutait `wishlist` en mémoire, et c'est cette version déjà amputée qui finissait
envoyée à Supabase — donnant l'impression que la restauration ne prenait pas, alors qu'elle
avait bien eu lieu un instant avant d'être re-écrasée.

C'est probablement aussi la cause-racine du vidage initial (34→1 entrées) : le même mécanisme
peut se déclencher pendant n'importe quel sync de plusieurs secondes, pas seulement une
restauration — un gros import Discogs/MusicBee inclus.

**Correctif.** Nouveau flag `_restoringSnapshot`, actif pendant tout `restoreSnapshot()` (jusqu'à
la fin de `saveToSupabase()`, y compris en cas d'erreur via `finally`) — bloque
`pruneWishlistOwned()`/`pruneNotesToReport()` à la fois dans `updateNavBadges()` et dans
`renderWishlist()` (qui l'appelait aussi directement). Une purge normale est relancée une seule
fois, proprement, une fois la restauration entièrement persistée.

⚠️ Ne corrige que la race condition de la restauration. Si le prune retire encore des entrées
légitimes après ce correctif, il faudra vérifier une éventuelle sur-correspondance dans
`wishlistOwnedSet()`/`normalizeKey` séparément (le `console.warn` existant
`"pruneWishlistOwned: entrées retirées"` liste les entrées concernées).

## v2026.07.10-19 — Correctifs UI : débordement menu + version fantôme "v2.0"

2 correctifs suite retour utilisateur (aucun lien avec la todo).

**(1) Débordement du menu de gauche.** L'ajout progressif d'entrées de nav (Complétude,
Prochain à écouter, Artistes similaires en -16/-17/-18) a fini par dépasser la hauteur de
viewport sur les résolutions courantes, sans scroll possible — les dernières entrées et le
bloc du bas (stockage, sauvegarde) devenaient inaccessibles. Restructuré en 3 zones :
`.sidebar-logo` (fixe en haut), `.sidebar-nav` (nouveau wrapper, `flex:1` +
`overflow-y:auto` — scroll indépendant), `.sidebar-bottom` (fixe en bas).

**(2) Version fantôme "v2.0".** Le sous-titre statique sous le logo affichait un numéro de
version fixe et obsolète, distinct du vrai numéro affiché dans la topbar (mis à jour à chaque
déploiement) — source de confusion. Retiré : la topbar reste la seule source de vérité.

## v2026.07.10-18 — Artistes similaires possédés

Todo section 11, 5e item traité.

Nouvel onglet **"🕸️ Artistes similaires"** (nav Outils, après Prochain à écouter) : réutilise
`album.mb_credits` (relations artiste au niveau release — producteur, remix, featuring,
membre… déjà récupérées en -11) sans aucun appel API supplémentaire.

Pour chaque crédit de chaque album possédé, si le nom crédité correspond (via
`artistVariants()`, même normalisation que le matching last.fm existant) à un artiste déjà
présent ailleurs dans la collection, c'est une connexion — volontairement pas de vraies
"similar artists" (nécessiterait une API dédiée type last.fm similar artists, hors scope), mais
des collaborations réelles et vérifiables entre artistes déjà possédés.

Tableau (Artiste / Connecté à / Rôle / Via l'album, cliquable), recherche par artiste,
compteur "X connexion(s) entre Y artiste(s)". 100% calculé côté client, aucune migration SQL,
rien de persisté.

## v2026.07.10-17 — "Prochain à écouter"

Todo section 11, 4e item traité.

Nouvel onglet **"🎧 Prochain à écouter"** (nav Outils, juste après Session notation) : même
principe de carte unique que la Session notation, mais objectif inverse — suggérer quoi écouter
**ensuite** plutôt que quoi noter parmi ce qui est déjà écouté.

Candidats : albums possédés jamais écoutés (`plays` à 0) + entrées wishlist (écouter avant
d'acheter). Score combiné : note RYM ×2 (facteur dominant) + bonus priorité wishlist (🔴 +3 /
🟡 +1.5 / 🟢 +0.5, uniquement pour les entrées wishlist).

Carte : pochette/avatar, artiste/album/année/genre, badges (source, priorité wishlist si
applicable, note RYM), boutons "▶️ Écouter sur YouTube Music", "📄 Ouvrir la fiche" (albums
possédés), "⏭ Suivant". File recalculée à chaque ouverture de l'écran, jamais persistée.

Aucune migration SQL, aucun appel réseau supplémentaire (réutilise les données déjà en mémoire).

## v2026.07.10-16 — Score de complétude de fiche

Todo section 11, 3e item traité.

Nouvel onglet **"🧩 Complétude"** (nav Outils, entre Pochettes et Session notation) : tableau
des albums possédés, triés par score croissant (pires fiches en premier), avec 4 critères
binaires par colonne — 🖼 pochette, 🎨 genre, ⭐ note, 📀 tracklist — et un score X/4 en
pourcentage. La tracklist est vérifiée via `albumTracksCache`, déjà chargé en bloc pour toute
la collection au démarrage (`loadAlbumTracks`), donc aucun appel réseau supplémentaire.

Recherche artiste/album, case "Masquer les fiches déjà complètes" (cochée par défaut),
pagination "Charger plus" (50/page, même pattern que Pochettes). Clic sur une ligne → ouvre la
fiche album. Badge sidebar = nombre de fiches "négligées" (score ≤ 2/4).

100% calculé côté client, aucune migration SQL, aucun state persisté.

## v2026.07.10-15 — Heatmap d'écoute

Todo section 11, 2e item traité (après le dashboard d'insights en -14).

Nouveau 6e bloc dans l'onglet **"📊 Insights"**, sous l'évolution des écoutes : calendrier
type GitHub (grille CSS — 1 colonne par semaine, 1 ligne par jour, intensité par opacité de
`var(--accent)`), calculé à la demande sur les 90 derniers jours. Contrairement à l'évolution
mensuelle (weekly charts, résolution hebdomadaire insuffisante pour un calendrier), reconstitué
depuis `user.getrecenttracks` — même endpoint que "Scrobbles récents" — filtré côté serveur
last.fm via `from=` pour ne récupérer que la fenêtre de 90 jours plutôt que paginer sur tout
l'historique (garde-fou de 60 pages max en cas de réponse anormale, dégradation gracieuse en
heatmap partielle plutôt que boucle infinie).

Résultat mis en cache (`listeningHeatmap` + `_listeningHeatmapComputedAt`), persisté comme
`listeningEvolution` via un nouveau `meta.listening_heatmap_data` (JSON, aucune migration SQL —
table `meta` déjà générique).

## v2026.07.10-14 — Dashboard d'insights

Todo section 11 (idées discutées juillet 2026), 1er item traité.

Nouvel onglet **"📊 Insights"** (nav + section). Calculs 100 % côté client, sauf
l'évolution des écoutes :

- **4 cartes résumé** : albums possédés, écoutes last.fm totales, % d'albums notés,
  note moyenne.
- **Genres** (top 12) et **décennies** — répartition des albums possédés
  (`ownedAlbumsForCovers()`, le même filtre déjà utilisé par Pochettes et Session
  notation).
- **Top 10 artistes par écoutes last.fm** (`_lastfmTrackCounts`) **vs top 10 par
  nombre d'albums possédés** — volontairement juxtaposés : les deux classements
  divergent souvent (artistes très écoutés mais peu achetés, ou l'inverse).
- **Évolution des écoutes par mois** : calculée **à la demande uniquement** (bouton
  dédié, jamais en auto) via les weekly charts Last.fm (`user.getweeklychartlist`
  puis `user.getweeklyartistchart`), bornée aux 104 dernières semaines (~2 ans) —
  l'historique complet sur 100k+ scrobbles coûterait des centaines d'appels
  séquentiels pour un gain marginal sur un simple dashboard (même logique de
  prudence que "Scrobbles récents", volontairement non persisté lui aussi). Résultat
  mis en cache (`listeningEvolution` + `_listeningEvolutionComputedAt`), persisté
  comme `trackYoutubeCache` via un nouveau `meta.listening_evolution_data` (JSON,
  **aucune migration SQL**).

Composant de rendu générique `renderBarList()` (barres horizontales CSS) réutilisé
pour les 4 blocs de répartition — aucune librairie de graphique externe ajoutée,
cohérent avec le reste de l'app (seules dépendances : Supabase, SheetJS). Nouvelle
classe CSS générique `.card` dans `styles.css` (dérivée de `.import-card` sans sa
sémantique import) pour les panneaux du dashboard.

---

## v2026.07.10-13 — 🐛 Correctif : ids "Morceaux isolés" cassés dans plusieurs onclick

Bug latent découvert pendant les tests de la v2026.07.10-12 (repli MB recording-level),
non lié à un item du todo.

**Root cause** : `tracks[].id` vaut `"artistNorm|||titleNorm"` — un texte contenant des
espaces (`normalizeKey()` les conserve). Ce texte était interpolé **brut, sans guillemets
ni encodage**, directement dans plusieurs attributs `onclick`/`onchange` de "Morceaux
isolés" :
- `rateTrack(${t.id},${i})` (clic étoile)
- `toggleTrackSelected(${t.id}, this.checked)` (case à cocher par ligne)
- `toggleSelectAllTracks()` : `parseInt(cb.dataset.id)` → `NaN` sur un id texte

Résultat : dès qu'un titre ou artiste contient un espace (quasi systématique avec de
vraies données MusicBee, ex. "Daft Punk" / "Discovery"), l'attribut généré est
syntaxiquement invalide en JavaScript — vérifié avec `node --check` sur un cas type avant
correctif. Les étoiles, la case à cocher et la sélection multiple de cette table étaient
donc probablement non fonctionnelles sur la quasi-totalité des morceaux isolés.

**Correctif** : reprise exacte du pattern déjà utilisé pour les albums
(`toggleAlbumSelected`/`toggleSelectAllAlbums`) — `sid()`/`unsid()` à l'émission
(attributs `onclick`/`onchange`/`data-id`) et au clic "tout sélectionner" (`dataset.id`
décodé via `unsid()` plutôt que `parseInt()`). `selectedTrackIds` continue de stocker les
ids réels (non encodés) en interne, comme `selectedAlbumIds` — seule la sérialisation
dans les attributs HTML change. Vérifié après correctif : roundtrip `sid()`/`unsid()` +
compilation `new Function()` des 3 attributs générés sur un cas avec espaces, tous OK.
Aucune migration, aucun changement de schéma Supabase.

---

## v2026.07.10-12 — Repli MusicBrainz recording-level pour l'écoute des morceaux

Todo section 8, dernier item ⬜ — dernier point de la section YouTube Music.

**`get-release-info.ts`** (à redéployer) : nouvelle branche `recording_id` dans la
source `musicbrainz` — lookup `recording/{id}?inc=url-rels`, extrait le lien "free
streaming"/"stream for free" vers YouTube s'il existe (même logique que le lien
release-level déjà utilisé pour `album.youtube_url`, mais au niveau morceau). Appelé
**uniquement au clic** ▶️ côté front, jamais en pré-fetch de masse — à 1 req/s, le
volume de pistes (morceaux isolés + pistes d'albums, dizaines de milliers) rendrait
un pré-fetch en masse totalement impraticable.

**Front (`app.js`)** : `fetchMusicBrainzRecordingYoutube()` appelle la nouvelle
branche ; `listenToTrackByRecording(artist, title, mbRecordingId)` est le point
d'entrée unique — repli silencieux et immédiat sur la recherche YouTube Music
existante si pas de `mb_recording_id` ou pas de lien direct trouvé. Résultat mis en
cache dans le nouveau state `trackYoutubeCache` (clé = `mb_recording_id`, universel
pour un morceau isolé comme pour une piste de tracklist d'album — évite de dupliquer
le cache par table), persisté comme `trackNoteOverrides` via un nouveau
`meta.track_youtube_cache_data` (JSON) — **aucune migration SQL nécessaire**, la
table `meta` est déjà un store clé/valeur générique.

Nouveau bouton ▶️ sur chaque ligne de "Morceaux isolés" et sur chaque piste du
panneau tracklist album (fiche album + Session notation mode Albums, via
`renderAlbumTracklistPanel`) ; `rsListenCurrent()` (Session notation mode Morceaux)
utilise désormais aussi ce repli au lieu d'une recherche texte systématique.

⚠️ **Bug pré-existant découvert au passage, non corrigé ici (hors scope)** : les ids
de morceaux isolés (`tracks[].id = "artistNorm|||titleNorm"`, texte contenant des
espaces) étaient déjà interpolés bruts (sans guillemets ni encodage) dans plusieurs
`onclick`/attributs existants de "Morceaux isolés" — `rateTrack()`,
`toggleTrackSelected()`, sélection multiple (`parseInt(cb.dataset.id)` y compris,
qui donne `NaN` sur un id texte). C'est syntaxiquement invalide en JavaScript dès
qu'un titre ou artiste contient un espace, ce qui est le cas quasi systématique avec
de vraies données MusicBee — vérifié avec `node --check` sur un cas type. Le nouveau
bouton ▶️ n'est **pas** affecté (utilise `sid()`/`unsid()`, comme pour les albums),
mais les étoiles, la case à cocher et la sélection multiple de cette table le sont
probablement. À confirmer et corriger dans une session dédiée.

---

## v2026.07.10-11 — Crédits MusicBrainz

Todo section 6, item ⬜ — **dernier des 4 items nécessitant l'Edge
Function**, tous traités.

**`get-release-info.ts`** (à redéployer) : `+artist-rels` ajouté à l'`inc=`
déjà utilisé pour le lookup release par `mb_id` — **aucun appel API
supplémentaire** (même requête). Extrait les relations artiste posées au
niveau release (`data.relations`, `target-type: "artist"`) en
`credits:[{role,name}]` — couvre producteur/ingénieur du
son/mixage/mastering/arrangement/etc. quand tagués au niveau release.

Le compositeur par morceau (lien recording→work) n'est **volontairement pas
récupéré** : nécessiterait 1 lookup MB par morceau à 1 req/s, coût
prohibitif — documenté dans le code et dans le panneau.

**Front (`app.js`)** : `fetchMusicBrainzRelease()` récupère `credits`,
`applyMbEnrichment()` (déjà appelée à tous les points d'enrichissement MB
existants) le stocke sur `album.mb_credits` — simple champ informatif comme
`mb_release_type`. 1 nouvelle colonne Supabase
(`migration_v2026.07.10-11.sql`).

Nouveau panneau **"🎛️ Crédits MusicBrainz"** dans la fiche album, sous le
panneau de comparaison Discogs/MusicBrainz, groupé par rôle avec libellés
français pour les rôles courants, masqué quand aucun crédit n'est
disponible.

---

## v2026.07.10-10 — Croisement master release Discogs

Todo section 6, item ⬜ "Croisement avec la master release Discogs (année
d'édition originale) comme 2e source".

**Edge Function `get-release-info.ts` mise à jour** (à redéployer) : la
branche Discogs suit désormais `data.master_id` vers `/masters/{id}` pour
récupérer l'année de 1re parution — 1 appel Discogs supplémentaire par
release liée à un master, uniquement lors du fetch initial/rafraîchissement
(pas de throttle nécessaire, Discogs n'a pas la limite stricte 1 req/s de
MusicBrainz). Renvoyé en `master_year`.

**Front (`app.js`)** : `fetchDiscogsRelease()` le récupère, stocké sur
`album.discogs_master_year` (`fetchAllTracklists` + `refreshAlbumFromSource`),
1 nouvelle colonne Supabase (`migration_v2026.07.10-10.sql`).

Le badge **"(orig. XXXX)"** existant (jusqu'ici `mb_original_year` seul)
devient `origYearBadge()` : croise `mb_original_year` et
`discogs_master_year` — accord → badge neutre comme avant, avec la ou les
source(s) précisée(s) en tooltip ; désaccord → badge ambre **"(orig.
MB:XXXX ≠ DC:YYYY ⚠️)"** signalant la divergence sans trancher à la place
d'Antoine, dans le même esprit que le panneau de comparaison multi-source
de la v05.

---

## v2026.07.10-09 — Type de release-group MusicBrainz

Todo section 6, item ⬜ "Type de release-group (album/EP/compil/live) pour
distinguer automatiquement les compils sans heuristique manuelle".

**Edge Function `get-release-info.ts` mise à jour** (fichier séparé, à
redéployer : `supabase functions deploy get-release-info`) : le
`primary-type`/`secondary-types` du release-group — déjà chargé pour
`first-release-date`/genres depuis la v06.5-6 — sont désormais aussi renvoyés
(`release_type`/`release_secondary_types`). Zéro appel API supplémentaire :
ce sont des champs natifs de la ressource release-group, retournés sans
`inc=` dédié.

**Front (`app.js`)** : `fetchMusicBrainzRelease()` les récupère,
`applyMbEnrichment()` les stocke sur `album.mb_release_type` /
`album.mb_release_secondary_types` — simple champ informatif, pas de
`field_provenance`/verrou nécessaire contrairement à year/genre/label
(toujours rafraîchi si la valeur change). 2 nouvelles colonnes Supabase
(`migration_v2026.07.10-09.sql`, dégradation gracieuse si non appliquée).

Nouveau badge discret (EP/Compil/Live/Remix/...) à côté du nom d'album en
Collection et Discographie (`mbTypeBadge()`) — rien affiché pour le cas
"Album" sans secondary-types, pour ne pas polluer la majorité des lignes.

`discoFilteredList()` : les heuristiques `isVA()`/`isEP()` (jusqu'ici
uniquement une regex sur le titre) utilisent désormais le type MB en
priorité quand disponible, avec repli sur la regex existante pour les
albums non encore liés à MusicBrainz.

---

## v2026.07.10-08 — Extraction JS → app.js

2ᵉ pas de la séparation JS/CSS (todo section 2, suite de la v07 qui avait
extrait le CSS).

Le bloc `<script>…</script>` principal (12 350 lignes) déplacé tel quel dans
**`app.js`**, remplacé dans `index.html` par `<script src="app.js"></script>`
au même emplacement (fin de `<body>`) — comportement de chargement/exécution
identique (script non-deferred, bloquant, exécuté après que le DOM au-dessus
soit déjà parsé, comme avant).

Extraction **mécanique pure**, aucune fonction ni variable renommée : les
~164 `onclick="..."` inline dans `index.html` continuent de référencer des
fonctions globales (`function foo(){}` au niveau racine reste global qu'il
soit inline ou chargé via `<script src>`) — aucune casse attendue.
`index.html` passe de 14 122 à **1 773 lignes**.

Le 2ᵉ bloc `<script>` du fichier (dans `buildOfflineHtml()`, généré comme
chaîne JS pour l'export HTML autonome hors-ligne) n'est **pas concerné**,
comme pour le CSS en -07.

**⚠️ Déploiement : 3 fichiers désormais à uploader ensemble sur GitHub
Pages** (`index.html` + `styles.css` + `app.js`) — un seul manquant casse
l'app entière.

---

## v2026.07.10-07 — Extraction CSS → styles.css

Premier pas de la todo section 2 ("Séparer progressivement JS/CSS du fichier
`index.html`"), volontairement limité au CSS : c'est la partie la plus simple
à extraire sans risque, sans références dynamiques (contrairement au JS qui
est truffé d'`onclick` inline référençant des fonctions globales — traité
séparément si souhaité).

Bloc `<style>…</style>` (612 lignes) déplacé tel quel dans **`styles.css`**,
remplacé dans `index.html` par `<link rel="stylesheet" href="styles.css">`.

Le 2ᵉ bloc `<style>` du fichier (dans `buildOfflineHtml()`, généré comme
chaîne JS pour l'export HTML autonome hors-ligne, section 7 de la todo) n'est
**pas concerné** — c'est un document HTML différent, généré à la volée, qui
doit rester autonome en un seul fichier téléchargeable.

**⚠️ Déploiement : à partir de cette version, il faut uploader `index.html`
ET `styles.css` ensemble sur GitHub Pages** (un seul fichier suffisait avant)
— sinon la page se charge sans mise en forme.

---

## v2026.07.10-06 — Genres RYM croisés

RYM propose souvent un genre plus fin/plus "ambiance" que Discogs/MusicBrainz
(ex. "Dream Pop" vs "Rock") — jusqu'ici seuls `rating`/`ownership` RYM étaient
exploités (todo section 6, item ⬜).

Nouvelle ligne **"Genre RYM : X (suggestion, jamais appliquée
automatiquement)"** en pied du panneau "Provenance des champs" de la fiche
album, visible dès qu'un match RYM (`lookupRym`, avec repli
`cleanDiscogsArtist` comme ailleurs dans le code) donne un genre différent du
genre actuel — même esprit que la suggestion de note RYM en Session notation
(jamais posée automatiquement, juste signalée).

Bouton "↳" pour appliquer explicitement, réutilise `applySourceFieldValue()`
(introduite en -05) avec `'rym'` comme source tracée dans `field_provenance` —
ajouté à `PROVENANCE_SOURCE_LABELS`.

---

## v2026.07.10-05 — Comparaison multi-source généralisée (year/genre/label/country)

Le pattern `cmp.discogs`/`cmp.musicbrainz` existant pour les tracklists
(`showTracklistDiff`) est étendu à `year`/`genre`/`label`/`country` (todo
section 2, item ⬜).

Nouveau panneau **"🔍 Comparaison Discogs / MusicBrainz"** dans la fiche album,
sous "Provenance des champs", peuplé quand `refreshAlbumFromSource()` dispose
des deux sources (album avec `discogsId` **et** `mb_release_id`) : cache session
`_sourceCmpCache` (comme `albumTracksCache`, jamais persisté en base — c'est une
aide au diagnostic ponctuel, pas une donnée de collection) avec les valeurs
brutes de chaque source par champ.

Affichage **display-only**, dans le même esprit que le diff tracklist :
n'automatise aucune résolution. Une divergence entre sources est signalée ⚠️ en
ambre ; un bouton "↳" par champ/source permet de choisir explicitement une
valeur à appliquer (`setProvenance` tracée sur la source choisie).

Le pays est affiché en comparaison mais **sans bouton Appliquer** : aucune
colonne `country` n'existe sur `albums` côté Supabase — informatif uniquement,
l'ajouter aurait nécessité une migration de schéma hors scope de ce correctif.

---

## v2026.07.10-04 — Filtrage/export combiné Stock + Wishlist

Suite à un audit du code demandé avant de reprendre la todo (section 4, item ⬜
"Filtrage/export combiné multi-critères sur toutes les vues") : Collection et
Discographie avaient déjà les filtres combinés (genre, notes MB/Discogs/RYM,
année, écoutes min) et l'export CSV du résultat filtré (`exportFilteredAlbumsCSV`,
`exportDiscoCSV`). Seuls Stock et Wishlist avaient un trou.

**Stock :** nouveau filtre note (même widget ≥/>/=/≤/∅/✓ que les autres vues),
intégré à `stockFilteredList()` — logique de filtrage extraite de `renderStock()`
pour être réutilisable — et couvert par les préréglages de filtres sauvegardés.
`exportStockCSV()` exporte désormais la liste filtrée au lieu de tout le stock.

**Wishlist :** pas de filtre genre ajouté — les entrées wishlist ne portent pas
ce champ dans le modèle actuel (aucun chemin d'ajout ne le renseigne), l'ajouter
aurait nécessité un changement de schéma hors scope d'un correctif. Logique de
filtrage extraite en `wishFilteredList()` (réutilisable) ; `exportWishlistCSV()`
exporte désormais la liste filtrée au lieu de toute la wishlist.

---

## v2026.07.10-03 — Retrait des ajouts/suppressions manuels (albums, morceaux)

Suite à une demande explicite : le principe de l'app est que les ajouts et
suppressions d'albums/morceaux passent uniquement par les imports MusicBee/Discogs
— jamais par saisie manuelle. Une entrée disparue du XML/CSV disparaît déjà
automatiquement de la collection au réimport (mécanisme `ghostAlbums` existant).

**Retiré :**
- "+ Album" (topbar, global), "+ Ajouter CD" (Discographie), "+ Ajouter au stock"
  (Stock), "+ Morceau" (Morceaux isolés).
- "✕ Supprimer" par ligne et en masse : Collection, Discographie, Stock,
  Morceaux isolés.
- Tous les boutons "＋ Ajouter" ouvrant la modale d'ajout manuel d'album depuis
  d'autres écrans : Morceaux manquants, RYM (missing / orphelins / audit
  ownership).
- Wishlist albums : "+ Ajouter" et "✓ Acquis" (ce dernier ouvrait lui aussi la
  modale d'ajout manuel). `pruneWishlistOwned()` est généralisée à **toutes**
  les sources (plus seulement lastfm/rym) : une entrée wishlist disparaît
  désormais automatiquement dès que l'album devient possédé, quel que soit son
  mode d'ajout d'origine — ce qui remplace le rôle du bouton "✓ Acquis".

**Conservé** (conformément à la demande — "hormis retrait de wishlist") :
retrait d'une entrée de la wishlist albums (`deleteWish`, `bulkDeleteWish`) et
de la wishlist morceaux (`deleteTrackWish`), ainsi que les outils de
maintenance existants non concernés par la demande (fusion manuelle de fiches
`mergeAlbumsManual`, diagnostic d'intégrité avec undo, association RYM/CD).

Toutes les fonctions JS devenues orphelines ont été supprimées avec leurs
boutons (`deleteAlbum`, `bulkDeleteAlbums`, `deleteStockItem`,
`bulkDeleteStock`, `deleteTrack`, `bulkDeleteTracks`, `openAlbumModal`,
`openTrackModal` + la modale `modal-track` entière, `addFromMissing`,
`addFromRYM` et ses 3 variantes indexées, `markWishAcquired`).

---

## v2026.07.10-02 — 3 correctifs (notes pistes MB, RYM wishlist, colonnes MB/DC wishlist)

Suite à un retour utilisateur avec captures d'écran :

**(1) BUG — note MusicBee par piste perdue au reload.** Le tag XML `Rating` (0-100)
de chaque piste, converti en 0-5 par `importMusicBeeTracklists()`, était bien calculé
en mémoire à l'import (visible tant que l'onglet restait ouvert) mais jamais persisté
dans `album_tracks` : colonne absente à la fois de l'INSERT (`saveTracklist`) et du
SELECT de rechargement (`loadAlbumTracks`). D'où les étoiles vides en Session notation
et la colonne "Note MB" à "–" dans "Tous les morceaux" après un rechargement de page,
malgré un XML correctement renseigné. `musicbee_tracks` (table dédiée aux morceaux
manquants) avait déjà cette colonne — seule `album_tracks` (la source réellement
utilisée par ces 2 écrans) en manquait. Migration `migration_v2026.07.10-02.sql` +
**un ré-import du XML MusicBee est nécessaire** pour backfiller les pistes déjà en base.

**(2) BUG — note RYM absente en Wishlist albums.** Les 3 chemins d'ajout à la
wishlist (manuel, depuis un album, depuis le stock) figeaient `rymRating: 0` sans
jamais appeler `lookupRym()` — seul l'ajout via la suggestion RYM calculait
correctement la note. `renderWishlist()` fait désormais un lookup RYM live
(`wishRymEntry()`) à l'affichage plutôt que de se fier à ce snapshot figé ; les 3
chemins d'ajout calculent aussi correctement `rymRating` (utilisé pour le tri/export).

**(3) Wishlist albums : notes MB/DC.** Nouvelles colonnes "Note MB" et "Note DC" (en
plus de "Note RYM" déjà présente), via `wishOwnedMatch()` qui cherche une fiche déjà
possédée sous un autre format pour le même artiste/album (cas fréquent : vinyle déjà
en collection, CD recherché en wishlist). Export CSV mis à jour en conséquence.

---

## v2026.07.10-01 — Provenance des champs

Todo section 2 ("nouveau — discuté juillet 2026"). Nouveau `album.field_provenance =
{ [champ]: { source, synced_at } }` pour year/genre/cover_url/label — colonne Supabase
`albums.field_provenance` (TEXT/JSON.stringify, migration `migration_v2026.07.10-01.sql`),
même convention que les autres champs JSON-as-text de l'app (folders, meta.*).

Remplace le pattern `if (!album.genre) album.genre = ...` sans traçabilité aux points
d'écriture concernés (enrichissement MusicBrainz, `fetchAllTracklists` Discogs/MB, cover
picker, imports CSV MusicBee génériques) : un champ verrouillé 🔒 "manuel" (édité depuis
la modale album, ou choisi manuellement — URL collée — dans le picker pochette) n'est
plus jamais écrasé par ces sources auto. Les deux imports authoritatifs existants
(Discogs CSV → `year`, MusicBee XML → `year`/`genre`) gardent leur comportement
volontaire d'écrasement systématique (décision antérieure pour ne pas rester bloqué sur
une valeur périmée) — ils enregistrent la provenance mais ignorent le verrou.

Nouveau panneau "Provenance des champs" dans la fiche album (source + fraîcheur relative
+ bouton verrou 🔒/🔓 par champ) et bouton générique "🔄 Rafraîchir depuis la source"
(recontacte Discogs/MusicBrainz selon les IDs liés à l'album, ignore les champs
verrouillés) — remplace le besoin de futurs boutons ad hoc par champ/source ;
`refreshMbYearGenres` reste en place séparément pour le backfill en masse
année/genre/youtube depuis Import/Export. `mergeAlbumsManual` (fusion manuelle de
fiches) reporte désormais la provenance des champs copiés depuis la fiche source.

---

## v2026.07.09-05 — Filtres sauvegardés généralisés (Discographie, Stock, Wishlist)

Suite de la v04 : la même mécanique de préréglages nommés couvre maintenant aussi
Discographie (14 champs), Stock et Wishlist (sets plus courts). Refactor en config par
vue (`FILTER_PRESET_VIEWS`) au lieu du code mono-vue précédent. Stockage localStorage
unifié (`terant_filter_presets_v2`), avec migration automatique des préréglages
Collection déjà enregistrés sous l'ancienne clé.

---

## v2026.07.09-04 — Filtres sauvegardés (Collection)

Menu déroulant "💾 Filtres…" + boutons 💾 (enregistrer) / ✕ (supprimer) dans la barre
d'outils de la Collection. Enregistre les 14 champs de filtrage/tri (artiste, album,
support, dossier, genre, notes MB/DC/RYM, année, écoutes min, tri) sous un nom choisi,
pour les rappeler en un clic. Stockage localStorage (`terant_filter_presets_collection_v1`,
état d'affichage local, pas une donnée de collection à synchroniser via Supabase). Limité
à la vue Collection pour l'instant — Discographie/Stock/Wishlist restent à faire.

---

## v2026.07.09-03 — Notation classique alimente aussi "Notes à reporter"

La notation classique (`rateAlbum` : clic étoiles Collection, `promptStockRating` :
saisie numérique, `rateTrack` : clic étoiles Morceaux isolés) alimente désormais "Notes
à reporter" via `queueNoteToReport()`, jusqu'ici scopée à la Session notation. Ne queue
que sur une note strictement positive (une note remise à 0 par re-clic ne crée pas
d'entrée), comportement cohérent avec celui déjà en place pour les pistes de tracklist.

## v2026.07.09-02 — Recherche globale unifiée

Nouveau bouton "🔎 Tout chercher" dans la topbar (+ raccourci Ctrl/Cmd+K depuis n'importe
quel écran) ouvrant une modale dédiée, distincte du champ `#global-search` existant (qui
reste un filtre local à la section affichée, comportement inchangé). Recherche en une
fois dans albums (tous dossiers confondus), morceaux isolés, wishlist albums et wishlist
morceaux ; résultats groupés par catégorie, triés par pertinence (exact > commence par >
contient), limités à 6-8 par groupe. Chaque résultat cliquable navigue directement vers
la bonne section et ouvre la fiche concernée (`editAlbum`/`openWishModal`/
`openTrackWishModal` quand une modale existe ; sinon la section est filtrée sur l'élément
exact via `#global-search`). Debounce 150ms sur la saisie, Échap pour fermer.

## v2026.07.09-01 — Détection de conflits de synchronisation

Nouvelle table `sync_state` (1 ligne, migration SQL livrée séparément) : compteur
`version` incrémenté atomiquement (update conditionnel `WHERE version=expectedVersion`)
à chaque `saveToSupabase()` réussie, avec `device_id`/`device_label` du dernier écrivain.
Avant tout sync : comparaison de la version distante à `_localSyncVersion` (fixée au
chargement) — si elles divergent, le sync est bloqué avant toute écriture, l'indicateur
passe en "⚠️ Conflit" (rouge, clignotant, cliquable), et une modale propose "🔄 Recharger
la version distante" ou "⚠️ Forcer l'écrasement" (confirmation requise). Identité
d'appareil : UUID + libellé auto-généré (plateforme + navigateur) dans localStorage,
renommable depuis la modale de conflit. Vérification périodique (45s, lecture seule) en
plus du check au moment du sync, pour détecter un conflit même sans sauvegarde en cours.
Dégradation gracieuse totale si la migration n'est pas appliquée (table absente).

## v2026.07.08-16 — Sélection multiple étendue

Mode sélection multiple étendu aux tableaux Discographie, Stock, Wishlist albums et
Morceaux isolés (jusqu'ici réservé à la Collection). Discographie réutilise directement
`selectedAlbumIds`/`bulk*()` de la Collection (mêmes fiches album). Stock : nouveau Set
`selectedStockIds` + barre dédiée (→ Collecter, 🎯 Wishlist, ✕ Supprimer en masse).
Wishlist albums : nouveau Set `selectedWishIds` + barre dédiée (🔴🟡🟢 priorité en masse,
✕ Supprimer). Morceaux isolés : nouveau Set `selectedTrackIds` + barre dédiée
(✕ Supprimer uniquement).

## v2026.07.08-15 — Notation piste : champ toujours visible

Le clic sur le titre de piste restait vulnérable à l'interception d'extension navigateur.
Ajout d'un vrai champ `<input>` numérique toujours visible sur chaque ligne de piste
(à côté des étoiles), avec bouton ✓ et Entrée pour valider — cible large, z-index dédié.
Chemin de mutation partagé via `submitAlbumTrackNoteInput()` → `_applyAlbumTrackRating()`.

## v2026.07.08-14 — Saisie numérique de note (alternative aux clics)

Ajout d'une saisie numérique de la note (champ + bouton "✓ Noter", Entrée pour valider)
comme alternative aux clics sur étoiles, pour l'album/morceau courant et pour chaque
piste de la tracklist embarquée. Refactor `_applyAlbumTrackRating()`. Mise en page Session
notation élargie (420px → 820px), pochette réduite, layout horizontal.

## v2026.07.08-13 — Correctif egress Supabase + RLS

**Bug egress corrigé** : `renderSnapshotsList()` téléchargeait la colonne `data` complète
(tout le JSON sérialisé) pour chacun des 10 snapshots à chaque ouverture de la modale ;
remplacé par une colonne `counts` légère calculée une fois à la création du snapshot.
RLS : migration SQL livrée activant Row-Level Security + policies permissives sur les 11
tables (satisfait l'audit Supabase, la clé anon reste publique dans le HTML statique donc
ça ne protège pas réellement les données).

## v2026.07.08-12 — Clarifications Scrobbles récents / Notes à reporter

Colonne RYM ajoutée à côté de Note dans la vue Albums de "Scrobbles récents". Vue
Morceaux : la notation n'est plus possible sur un scrobble sans correspondance réelle
dans la collection. "Notes à reporter" : onglets de filtre Tout/Albums/Morceaux,
regroupement visuel par type, compteur détaillé par type.

## v2026.07.08-11 — Mesures défensives demi-étoiles (extension navigateur)

Investigation du bug "les demi-étoiles ne marchent toujours pas" : test isolé (jsdom,
clic DOM réellement dispatché) confirmant que la mécanique clic → `rateAlbumTrack()` →
`trackNoteOverrides` fonctionne correctement côté code. Cause probable identifiée : une
extension navigateur (icône flottante losange/étincelle) interceptant le clic. Mesures
défensives : cible de clic agrandie (15px → 18px), z-index explicite.

## v2026.07.08-07 — Notation depuis les Scrobbles récents + fusion Pistes d'albums

Les vues Albums/Morceaux de "🕐 Scrobbles récents" ont une colonne Note cliquable
(demi-étoiles). Le 3ᵉ mode "💿 Pistes d'albums" de la Session notation est fusionné dans
l'onglet "🎵 Albums" : panneau tracklist affiché directement sous la pochette/étoiles de
l'album en cours de notation (`renderAlbumTracklistPanel()` généralisée).

## v2026.07.08-05 — Journal des changements

Écran "📰 Journal" (nav Outils) : compare l'état actuel à un snapshot Supabase choisi
(auto-comparé au plus récent à l'ouverture). Ajoutés / Supprimés / Déplacés / Note
MusicBee changée, diff par clé normalisée. Bouton "📸 Nouveau snapshot" accessible
directement depuis l'écran.

## v2026.07.08-02 — Sélection multiple (Collection)

Case à cocher par ligne + "tout sélectionner (page)", sélection persistante entre pages
filtrées, barre d'actions groupées (🎯 wishlist, 💸 marquer à vendre, ✅ retirer de Ok,
✕ supprimer) pour la vue Collection.

## v2026.07.08-01 — 3ᵉ mode Session notation : Pistes d'albums

Nouvel onglet dédié dans l'écran Session notation qui file toutes les pistes MusicBee/
Discogs des albums possédés sans note, triée par écoutes last.fm décroissantes (fusionné
dans l'onglet Albums dès la v2026.07.08-07, cf. plus haut).

## v2026.07.07-12 — Score de confiance MusicBrainz / RYM

Panneau dans le détail album montrant comment MusicBrainz et RYM ont matché :
MusicBrainz affiche le score de recherche floue (`albums.mb_match_score`, migration SQL)
avec bouton de réinitialisation ; RYM distingue correspondance exacte / variante d'artiste
/ association manuelle via `lookupRymWithMeta()`.

## v2026.07.07-8 — Notation des pistes de tracklist, demi-étoiles

Dans la modale d'édition d'un album, widget 5 étoiles en demi-pas pour chaque piste de la
tracklist MusicBee. Stocké dans `trackNoteOverrides` (clé `albumId§titreNormalisé`),
volontairement hors `albumTracksCache` pour survivre aux réimports XML.

## v2026.07.07-7 — Vue "Notes à reporter"

L'app n'écrivant jamais dans MusicBee/Discogs/RYM, chaque note posée via la Session
notation génère une entrée listant les cibles externes encore à mettre à jour
manuellement (MusicBee toujours, + Discogs/RYM selon les cas). Auto-décoché à la
détection d'un réimport CSV correspondant. Export CSV, badge sidebar, persistée Supabase.

## v2026.07.07-6 — Session notation : extension aux morceaux isolés

Sélecteur "🎵 Albums / 🎧 Morceaux isolés" en haut de l'écran Session notation, deuxième
file dédiée aux morceaux, même priorisation et raccourcis clavier.

## v2026.07.07-5 — Mode "Session de notation"

Écran dédié (nav "🎯 Session notation") présentant un album non noté à la fois : grosse
pochette, lien YouTube Music, 5 étoiles cliquables, raccourcis clavier 1-5/S, suggestion
RYM en encart, barre de progression sur l'ensemble de la collection possédée.

## v2026.07.07-2 — Filtres galerie Pochettes

Filtres supplémentaires dans la galerie (dossier, genre, plage d'années, tri), icône de
dossier + année/genre affichés sur chaque vignette.

## v2026.07.07-1 — Galerie Pochettes

Vue galerie dédiée (nav "🖼 Pochettes") : grille de vignettes, filtres Sans pochette/Basse
résolution/Toutes, recherche, pagination. Détection de basse résolution asynchrone.
Modale "choisir la pochette" (Discogs + last.fm + URL manuelle).

## v2026.07.06-9 — Abandon Qobuz au profit de YouTube Music

Qobuz abandonné après plusieurs échecs (404, résultats vides, SPA nécessitant
potentiellement une connexion). Remplacé par YouTube Music (fonctionne sans compte),
lien direct via relation MusicBrainz "free streaming" quand disponible.

## v2026.07.06-5 → -6 — Enrichissement MusicBrainz (année réelle, genres)

Edge Function enrichie : lookup `release-group/{id}?inc=genres` en complément du lookup
`release/{id}`, pour récupérer `first-release-date` et les genres du release-group.
Nouveau champ `mb_original_year` (jamais utilisé pour écraser `year`), badge
`(orig. XXXX)`. Bouton "🗓 Rafraîchir année/genre MB" pour backfill.

## v2026.07.05-4 → -7 — Diagnostic d'intégrité & robustesse dédoublonnage

Diagnostic d'intégrité (bouton 🩺) : doublons wishlist, dossiers vides, morceaux
incomplets, notes hors plage, wishlist déjà possédée en CD — avec undo/snapshot par
correction. Guard `albumsLookLikeHomonyms()` empêchant la fusion d'albums homonymes
légitimes. Tests de non-régression `normalizeKey`/`stableAlbumId`.

---

## Avant v2026.07.05

Historique antérieur non détaillé ici — l'app a évolué depuis une version single-source
plus simple, avec une migration de backend Firebase/Firestore vers Supabase PostgreSQL
(limite de taille de document Firestore atteinte). Voir la section "Purpose & context"
du fil de discussion Claude pour le contexte général du projet.
