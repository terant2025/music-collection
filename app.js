// Terant Music Collection — logique JS de l'application.
// Extrait de index.html (v2026.07.10-08, cf. CHANGELOG.md) — le suivi de version
// (APP_VERSION, badge topbar) reste dans index.html, ce fichier n'a pas de en-tête dupliqué.
// ===================== STATE =====================
let albums = [];   // { id:text, artist, album, year, genre, folders:[], has_cd, format, note, plays, notes, discogsId, mb_release_id, mb_match_score, mb_original_year, mb_refreshed_at, youtube_url, cover_url, lastfmAliases, label, catno, isCompilation }
// mb_original_year : année de première parution (release-group MusicBrainz), distincte de `year`
// qui peut refléter une réédition/remaster précise — jamais utilisé pour écraser `year` automatiquement.
let tracks = [];   // morceaux isolés { artistNorm, titleNorm, artist, title, album, format, duration, note, mb_recording_id }
let stockItems = []; // DEPRECATED — conservé pour compat rendering, peuplé depuis albums[folder='stock']
let lastfmData = [];
let rymData = [];
let associations = [];    // [{cdKey, numKey}] — clés texte stables
let rymAssociations = []; // [{rymKey, albumKey}] — clés texte stables
let notesToReport = []; // [{ id, type:'album'|'track', key, artist, title, note, targets:['musicbee','discogs','rym'], createdAt }]
// File des notes posées dans l'app (session de notation ou table classique) à reporter
// manuellement dans les sources externes réelles (MusicBee, Discogs, RYM ne sont PAS
// synchronisées automatiquement — l'app n'est qu'un agrégateur). Se vide automatiquement
// pour discogs/rym quand un réimport détecte la note côté source ; MusicBee se coche
// manuellement (pas d'API locale pour détecter un rescan).
let trackNoteOverrides = {}; // { "albumId§titreNormalisé": note (0-5, pas de 0.5) }
// Note posée dans l'app pour un morceau de la tracklist d'un album, indépendante du champ
// `rating` importé depuis MusicBee (arrondi à l'étoile entière, écrasé à chaque réimport XML).
// Stockée à part (jamais dans albumTracksCache) pour survivre aux réimports.
let trackYoutubeCache = {}; // { [mb_recording_id]: url ('' = déjà cherché, rien trouvé) }
// Lien YouTube direct par MORCEAU (relation MB recording→url), todo section 8 dernier item ⬜.
// Contrairement au lien par ALBUM (album.youtube_url, récupéré en masse lors de l'enrichissement
// release), celui-ci n'est récupéré qu'À LA DEMANDE (1 clic ▶️) — le volume de pistes (morceaux
// isolés + pistes d'albums, dizaines de milliers) rendrait un pré-fetch en masse à 1 req/s MB
// totalement impraticable. Clé = mb_recording_id (universel, valable aussi bien pour un morceau
// isolé que pour une piste de tracklist d'album) plutôt qu'un ID propre à chaque table — évite
// de dupliquer le cache par source. Stocké à part comme trackNoteOverrides, jamais dans les
// tables tracks/album_tracks elles-mêmes (qui sont réécrites entièrement à chaque réimport XML).
let listeningEvolution = []; // [{ month:'YYYY-MM', plays }] — todo section 11, Dashboard d'insights.
// Calculé À LA DEMANDE (bouton dédié) depuis les weekly charts Last.fm (user.getweeklychartlist +
// user.getweeklyartistchart, bornée aux 104 dernières semaines) — jamais en auto, ni sur toute
// l'historique du compte (des centaines d'appels API pour 100k+ scrobbles, pour un gain marginal
// sur un simple dashboard). Persisté (comme trackYoutubeCache) pour éviter de recalculer à
// chaque visite de l'écran Insights ; rafraîchissable manuellement.
let _listeningEvolutionComputedAt = null;
let listeningHeatmap = []; // [{ date:'YYYY-MM-DD', plays }] — todo section 11, "Heatmap d'écoute".
// Calculé À LA DEMANDE depuis user.getrecenttracks (comme "Scrobbles récents"), borné aux 90
// derniers jours via le paramètre from= de l'API (filtre côté serveur last.fm, pas de sur-fetch) —
// contrairement à l'évolution mensuelle ci-dessus qui s'appuie sur les weekly charts (résolution
// hebdo insuffisante pour une heatmap calendrier). Persisté comme listeningEvolution.
let _listeningHeatmapComputedAt = null;
// Évolution du goût (todo section 11, item ⬜ « le dashboard Insights montre une répartition
// genres/décennies figée à aujourd'hui — réutilise des données déjà chargées, juste un angle
// temporel en plus »). Construit dans la MÊME boucle que loadListeningEvolution() (aucun appel
// réseau supplémentaire) : chaque semaine des weekly charts donne déjà un total par artiste,
// il suffit de retrouver le genre de chaque artiste (via les albums possédés) pour ventiler ce
// même total par genre en plus du total mensuel déjà calculé. Persisté comme listeningEvolution.
let genreEvolution = []; // [{ month:'YYYY-MM', genres:{ genre: plays } }]
let _genreEvolutionComputedAt = null;
// Historique de valeur collection (todo section 11, item ⬜ « Valeur collection est un
// instantané figé — conserver un point de valeur par mois donnerait une vraie courbe »).
// Contrairement à listeningEvolution/genreEvolution (qui nécessitent des appels last.fm),
// ceci est purement une photo des prix DÉJÀ estimés (marketplace_price, rempli par
// fetchAllMarketplaceStats) — capturé automatiquement à chaque visite de l'onglet Valeur
// collection, un seul point par mois (écrase le point du mois en cours s'il existe déjà).
let marketValueHistory = []; // [{ month:'YYYY-MM', total, count, currency }]
let modalNote = 0;
let trackNote = 0;
let currentPage = 1;
let discoPage = 1;
const PAGE_SIZE = 30;
let nextId = 1; // conservé pour tracks isolés uniquement
let _saveTimer = null;

// Génère un ID stable pour un album : toujours normalizeKey(artist, album)
// On n'utilise PAS mb_release_id comme ID — trop instable (Picard re-tague)
// Le MBID est stocké séparément dans mb_release_id pour les lookups optionnels
function stableAlbumId(artist, album, mb_release_id, discogs_id) {
  const base = normalizeKey(artist, album);
  // Pour les albums homonymes du même artiste, le discogsId est le seul discriminant fiable
  if (discogs_id) return base + '|||dc:' + discogs_id;
  return base;
}

// Mélange Fisher-Yates in-place (retourne le même tableau pour chaînage) — utilisé notamment
// par la Session notation (v2026.07.12-12, demandé par Antoine : ordre aléatoire plutôt que
// trié par écoutes, pour que les albums/morceaux jamais écoutés aient autant de chances
// d'apparaître en premier que les plus scrobblés).
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// primaryFolder DOIT toujours être une fonction pure de folders[] (jamais un flag manuel —
// confirmé par grep, aucun bouton UI ne l'écrit directement) — hiérarchie : discographie >
// forsale > ok > stock > album. 'ok' prime sur 'stock' intentionnellement (cf. correctif
// v2026.07.12-09 : un album déplacé de Stock vers Ok dans MusicBee doit afficher "Ok").
function derivePrimaryFolder(folders) {
  if (!folders) return 'album';
  if (folders.includes('discographie')) return 'discographie';
  if (folders.includes('forsale'))      return 'forsale';
  if (folders.includes('ok'))           return 'ok';
  if (folders.includes('stock'))        return 'stock';
  return 'album';
}

// ===================== LOCALSTORAGE =====================
const LS_KEY = 'discotheque_v2';
const LS_CFG = 'discotheque_backend_cfg';
// Cache local des grosses tables (lastfm_tracks — 100k+ lignes chez Antoine) + version
// sync_state associée, pour permettre à connectSupabase() de sauter le rechargement réseau
// complet quand rien n'a changé côté serveur — v2026.07.10-33, cf. CHANGELOG (economie d'egress).
const LS_LASTFM_TRACKS_KEY = 'discotheque_lastfm_tracks';
const LS_SYNC_VERSION_CACHE = 'discotheque_sync_version';

function _saveToStorageImpl() {
  setSaveIndicator('saving');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      // Cache local systématique — AVANT v2026.07.10-33, ceci n'écrivait rien tant que Supabase
      // était configuré (branche else uniquement) : au rechargement de page suivant, aucun cache
      // n'existait, donc connectSupabase() retéléchargeait TOUJOURS tout depuis zéro (albums +
      // lastfm_data + lastfm_tracks 100k+ lignes), à chaque ouverture, sur chaque appareil — cause
      // racine du dépassement d'egress Supabase (134% du quota gratuit) alors que la taille de la
      // DB elle-même restait sous le quota (48%). Écrit désormais toujours, permettant à
      // connectSupabase() de sauter le rechargement réseau complet via sync_state.version.
      writeLocalCache();
      if (window._sb) {
        await saveToSupabase();
      } else {
        setSaveIndicator('saved', new Date().toISOString());
      }
    } catch(e) {
      setSaveIndicator('error');
      console.error('Sauvegarde échouée', e);
    }
  }, 600);
}

// Écrit l'état courant (albums/tracks/wishlist/… + lastfmData + rymData) dans localStorage.
// Try/catch dédié : le quota localStorage (5-10 Mo selon navigateur) peut être dépassé sur une
// grosse collection — dans ce cas le cache reste simplement absent/partiel (silencieux, non
// bloquant), connectSupabase() retombera sur un rechargement réseau complet comme avant ce
// correctif. Supabase reste dans tous les cas la source de vérité, jamais ce cache.
// 🐛 v2026.07.12-15 (Antoine, "Cache local non écrit" en boucle) : les 3 clés étaient écrites
// dans UN SEUL try/catch — si LS_KEY (le plus gros, ~3 Mo albums+tracks+etc) dépassait le
// quota, les 2 écritures suivantes (discotheque_lastfm, discotheque_rym — plus petites, plus
// susceptibles de rentrer) n'étaient même pas tentées. Chaque clé a maintenant son propre
// try/catch : un échec sur l'une n'empêche plus les autres. lastfmData/rymData servi aussi en
// format compact délimité (\x1f) plutôt qu'un tableau d'objets JSON, même logique que
// writeLastfmTracksCache() ci-dessus, pour un peu de marge en plus sur le quota partagé.
function writeLocalCache() {
  const now = new Date().toISOString();
  try {
    const data = { albums, tracks, stockItems, associations, rymAssociations, wishlist, trackWishlist, notesToReport, trackNoteOverrides, trackYoutubeCache, listeningEvolution, listeningEvolutionComputedAt: _listeningEvolutionComputedAt, listeningHeatmap, listeningHeatmapComputedAt: _listeningHeatmapComputedAt, genreEvolution, genreEvolutionComputedAt: _genreEvolutionComputedAt, marketValueHistory, nextId, savedAt: now };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch(e) {
    console.warn('Cache local (localStorage) non écrit — quota probablement dépassé, prochain chargement retéléchargera tout —', e.message || e);
  }
  try {
    if (lastfmData.length) {
      const payload = lastfmData.map(d => [d.artist, d.album, d.plays || 0].join('\x1f')).join('\n');
      localStorage.setItem('discotheque_lastfm', payload);
    }
  } catch(e) {
    console.warn('Cache local lastfm (albums) non écrit —', e.message || e);
  }
  try {
    if (rymData.length) {
      const payload = rymData.map(d => [d.artist, d.album, d.rating || 0, d.ownership || ''].join('\x1f')).join('\n');
      localStorage.setItem('discotheque_rym', payload);
    }
  } catch(e) {
    console.warn('Cache local RYM non écrit —', e.message || e);
  }
}

// Cache séparé pour _lastfmTrackCounts (table lastfm_tracks, 197k+ lignes chez Antoine) — à part
// de writeLocalCache() car alimentée par un fetch en arrière-plan qui peut se terminer bien après
// le reste (voir loadLastfmFromSupabase()), et volumineuse (tuples compacts plutôt qu'objets,
// pour rester sous le quota localStorage autant que possible).
// 🐛 v2026.07.12-15 (Antoine, "Cache local lastfm_tracks non écrit" en boucle) : sur 197k
// morceaux, même en tuples JSON compacts [artist,track,album,plays], le poids sérialisé
// dépasse ~9,6 Mo — au-dessus du quota localStorage typique (5-10 Mo, PARTAGÉ avec le reste
// de l'app, cf. writeLocalCache) à lui seul. Résultat concret avant ce correctif : ce cache
// n'était quasiment jamais écrit avec succès, donc l'optimisation d'egress de juillet
// (sync_state.version, cf. v2026.07.10-33) ne jouait plus son rôle pour cette table — un
// rechargement complet depuis Supabase (197k lignes) à chaque session, silencieusement.
// 2 leviers : (1) sérialisation en une seule string délimitée par \x1f plutôt qu'un tableau de
// tuples JSON — évite de répéter crochets/guillemets/virgules par ligne, ~25-30% plus compact
// pour ce volume ; (2) si ça ne suffit toujours pas, réessaie avec un seuil d'écoutes minimum
// croissant (0 → 1 → 2 → 3 → 5) plutôt que d'abandonner tout le cache d'un coup — mieux vaut
// garder en cache les morceaux les plus écoutés (les plus utiles pour "Manquants — Morceaux"
// et Session notation, déjà triés par écoutes) que perdre 100% du cache pour quelques milliers
// d'entrées à 1 écoute qui ne remontent de toute façon jamais en tête des listes triées.
function writeLastfmTracksCache() {
  try {
    const entries = Object.values(_lastfmTrackCounts || {});
    if (!entries.length) return;
    const sorted = entries.slice().sort((a, b) => (b.plays || 0) - (a.plays || 0));
    const thresholds = [0, 1, 2, 3, 5];
    for (const minPlays of thresholds) {
      const subset = minPlays === 0 ? sorted : sorted.filter(d => (d.plays || 0) >= minPlays);
      if (!subset.length) break;
      const payload = subset.map(d => [d.artist, d.track, d.album || '', d.plays || 0].join('\x1f')).join('\n');
      try {
        localStorage.setItem(LS_LASTFM_TRACKS_KEY, payload);
        if (minPlays > 0) console.warn(`Cache lastfm_tracks réduit à ${subset.length}/${entries.length} morceaux (≥${minPlays} écoute(s)) pour tenir sous le quota localStorage.`);
        return;
      } catch(e) { /* essai suivant avec un seuil plus élevé */ }
    }
    console.warn('Cache local lastfm_tracks non écrit — quota dépassé même réduit au maximum, prochain chargement retéléchargera tout.');
  } catch(e) {
    console.warn('Cache local lastfm_tracks non écrit —', e.message || e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    albums = data.albums || [];
    tracks = data.tracks || [];
    stockItems = data.stockItems || [];
    rymData = data.rymData || []; // rétrocompat anciens saves
    associations = data.associations || [];
    rymAssociations = data.rymAssociations || [];
    wishlist = data.wishlist || [];
    trackWishlist = data.trackWishlist || [];
    notesToReport = data.notesToReport || [];
    trackNoteOverrides = data.trackNoteOverrides || {};
    trackYoutubeCache = data.trackYoutubeCache || {};
    listeningEvolution = data.listeningEvolution || [];
    _listeningEvolutionComputedAt = data.listeningEvolutionComputedAt || null;
    listeningHeatmap = data.listeningHeatmap || [];
    _listeningHeatmapComputedAt = data.listeningHeatmapComputedAt || null;
    genreEvolution = data.genreEvolution || [];
    _genreEvolutionComputedAt = data.genreEvolutionComputedAt || null;
    marketValueHistory = data.marketValueHistory || [];
    nextId = Math.max(nextId, data.nextId || 0, computeNextId());
    if (repairDuplicateIds()) saveToStorage();
    setSaveIndicator('saved', data.savedAt);
    loadLastfmFromLocalStorage();
    loadLastfmTracksFromLocalStorage();
    loadRymFromLocalStorage(); // écrase rymData si clé dédiée présente
    return true;
  } catch(e) { return false; }
}

// ===================== SYNC CONFLICT DETECTION (v2026.07.09) =====================
// Compteur atomique meta.sync_state.version : chaque saveToSupabase() réussie l'incrémente.
// _localSyncVersion = dernière version connue par CET onglet (fixée au chargement et après
// chaque sauvegarde réussie). Si au moment de sauvegarder la version distante a changé (un
// autre onglet/appareil a sauvegardé entre-temps), on bloque le sync destructeur au lieu
// d'écraser silencieusement — cf. section 3 de ameliorations-collection.md.
// Dégrade gracieusement si la table sync_state n'existe pas encore (migration non appliquée) :
// _localSyncVersion reste null, aucune vérification n'est faite, comportement identique à avant.
let _localSyncVersion = null;
let _syncConflict = null; // { remoteVersion, remoteDeviceLabel, remoteAt } quand un conflit est détecté
let _syncTableMissing = false;

function getDeviceId() {
  let id = localStorage.getItem('device_uuid');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    localStorage.setItem('device_uuid', id);
  }
  return id;
}
function getDeviceLabel() {
  let label = localStorage.getItem('device_label');
  if (!label) {
    const ua = navigator.userAgent || '';
    const browser = ua.includes('Firefox') ? 'Firefox' : ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Safari') ? 'Safari' : 'Navigateur';
    label = (navigator.platform || 'Appareil') + ' · ' + browser;
    localStorage.setItem('device_label', label);
  }
  return label;
}
function renameDevice() {
  const cur = getDeviceLabel();
  const next = prompt('Nom de cet appareil (affiché en cas de conflit de synchronisation) :', cur);
  if (next && next.trim()) {
    localStorage.setItem('device_label', next.trim());
    const el = document.getElementById('sync-device-label');
    if (el) el.textContent = next.trim();
    toast('Appareil renommé ✓');
  }
}

// Récupère { version, device_label, updated_at } depuis sync_state, ou null si la table
// n'existe pas (migration non appliquée) ou en cas d'erreur réseau.
async function fetchSyncState() {
  if (!window._sb) return null;
  try {
    const { data, error } = await window._sb.from('sync_state').select('version,device_label,updated_at').eq('id', 1).single();
    if (error) {
      if (error.code === 'PGRST205' || error.message?.includes('does not exist') || error.code === '42P01') {
        _syncTableMissing = true;
      } else if (error.code !== 'PGRST116') {
        // PGRST116 = 0 ligne trouvée pour .single() (id=1 pas encore seedée) — cas normal avant
        // le premier bump, pas la peine de polluer la console. Toute autre erreur (RLS, etc.)
        // mérite un warning pour rester diagnosticable (cf. bug v2026.07.10-20).
        console.warn('sync_state : lecture échouée —', error.message || error);
      }
      return null;
    }
    _syncTableMissing = false;
    return data;
  } catch (e) { return null; }
}

// Appelé après un load() réussi : fixe la référence locale sans jamais bloquer.
async function syncVersionAfterLoad() {
  const st = await fetchSyncState();
  _localSyncVersion = st ? st.version : (_syncTableMissing ? null : 0);
  _syncConflict = null;
  // Persisté (contrairement à _localSyncVersion, un simple `let` qui ne survit pas à un
  // rechargement de page) — c'est cette valeur que connectSupabase() compare à la version
  // distante au prochain lancement pour décider s'il peut sauter le rechargement réseau complet.
  try {
    if (_localSyncVersion !== null) localStorage.setItem(LS_SYNC_VERSION_CACHE, String(_localSyncVersion));
    else localStorage.removeItem(LS_SYNC_VERSION_CACHE);
  } catch(e) {}
}

// Vérification périodique légère (n'écrit rien) : détecte un conflit même sans sauvegarde
// en cours, utile car Antoine garde des onglets ouverts en parallèle sans les recharger.
async function pollSyncVersion() {
  if (!window._sb || _localSyncVersion === null || _syncConflict || _savingToSupabase) return;
  const st = await fetchSyncState();
  if (st && st.version !== _localSyncVersion) {
    _syncConflict = { remoteVersion: st.version, remoteDeviceLabel: st.device_label || 'un autre appareil', remoteAt: st.updated_at };
    setSaveIndicator('conflict');
  }
}
setInterval(pollSyncVersion, 45000);

function openSyncConflictModal() {
  if (!_syncConflict) return;
  const when = _syncConflict.remoteAt ? new Date(_syncConflict.remoteAt).toLocaleString('fr-FR') : '';
  document.getElementById('sync-conflict-detail').textContent =
    `Une autre session (${_syncConflict.remoteDeviceLabel}) a sauvegardé la collection${when ? ' le ' + when : ''}, après le dernier chargement de cet onglet. Vos modifications locales n'ont pas encore été écrasées, mais la synchronisation automatique est en pause pour éviter de perdre des données.`;
  const devEl = document.getElementById('sync-device-label');
  if (devEl) devEl.textContent = getDeviceLabel();
  document.getElementById('modal-sync-conflict').classList.add('open');
}
function closeSyncConflictModal() {
  document.getElementById('modal-sync-conflict').classList.remove('open');
}
async function resolveSyncConflict(mode) {
  if (mode === 'reload') {
    closeSyncConflictModal();
    toast('Rechargement de la version distante…');
    const ok = await loadFromSupabase();
    if (ok) toast('Version distante rechargée ✓');
  } else if (mode === 'force') {
    if (!confirm('Écraser la version distante avec les données de cet onglet ? Les modifications faites ailleurs depuis le dernier chargement seront perdues.')) return;
    closeSyncConflictModal();
    _syncConflict = null;
    await saveToSupabase({ force: true });
  }
}

// ===================== SUPABASE =====================
const SUPABASE_URL = 'https://mjedlmumiljdrmjobefm.supabase.co';
const EDGE_FN_URL  = 'https://mjedlmumiljdrmjobefm.supabase.co/functions/v1/get-release-info';
const LS_ANON_KEY = 'supabase_anon_key';
window._sb = null; // client Supabase

async function connectSupabase(anonKey) {
  const errEl = document.getElementById('setup-error');
  if (errEl) errEl.textContent = '';
  const key = anonKey || document.getElementById('cfg-anon-key')?.value.trim();
  if (!key) {
    if (errEl) errEl.textContent = 'Clé API requise.';
    return false;
  }
  try {
    window._sb = supabase.createClient(SUPABASE_URL, key);
    // Test léger de connexion : on accepte not-found (PGRST116) et RLS (42501)
    // car la table peut exister mais bloquer la lecture anonyme
    const { error } = await window._sb.from('meta').select('value').eq('key', 'next_id').single();
    const ignoredCodes = ['PGRST116', '42501', 'PGRST301'];
    if (error && !ignoredCodes.includes(error.code)) throw error;
    localStorage.setItem(LS_ANON_KEY, key);
    localStorage.setItem(LS_CFG, 'supabase');
    const setupEl = document.getElementById('supabase-setup');
    if (setupEl) setupEl.style.display = 'none';
    // Économie d'egress (v2026.07.10-33) : avant de retélécharger TOUT (albums + lastfm_data +
    // lastfm_tracks 100k+ lignes...), vérifier via un appel léger (sync_state, 1 ligne) si la
    // version distante correspond à celle du dernier chargement réussi de CE navigateur — si
    // oui, rien n'a changé côté serveur depuis, le cache local (localStorage, écrit par
    // writeLocalCache()/writeLastfmTracksCache() à chaque save/load précédent) est encore valide
    // et sert de source directement, sans passer par le réseau pour les grosses tables.
    let usedLocalCache = false;
    try {
      const remoteState = await fetchSyncState();
      const cachedVersion = localStorage.getItem(LS_SYNC_VERSION_CACHE);
      if (remoteState && cachedVersion !== null && String(remoteState.version) === cachedVersion) {
        if (loadFromStorage()) {
          usedLocalCache = true;
          _localSyncVersion = remoteState.version;
          _syncConflict = null;
          console.log(`Sync : cache local utilisé (version ${remoteState.version} inchangée) — rechargement réseau complet évité`);
          // album_tracks/musicbee_tracks (tracklists + détection "morceaux manquants") ne sont
          // PAS encore mis en cache localStorage — portée de ce 1er passage volontairement
          // limitée aux 2 plus grosses tables (lastfm_data + lastfm_tracks, ~154k lignes à
          // elles seules, l'essentiel du problème d'egress). Rechargées normalement ici, coût
          // réseau modeste en comparaison — à mettre en cache aussi dans un 2e temps si l'egress
          // reste élevé après ce correctif.
          loadAlbumTracks();
          loadMusicBeeTracks();
          loadLastfmTrackStatus();
          loadLovedTracks();
        }
      }
    } catch(e) { /* en cas de doute, on retombe sur le rechargement complet ci-dessous */ }
    const loaded = usedLocalCache ? true : await loadFromSupabase();
    // Ne pas sauvegarder si la collection est vide (ex: après migration — évite de purger les associations)
    if (!loaded && albums.length > 0) await saveToSupabase();
    _dataReady = true;
    // Maintenance wishlist (migration morceaux mal classés, purge entrées corrompues,
    // purge entrées déjà possédées) — doit tourner ici, PAS seulement dans initApp(),
    // car c'est ce chemin (reconnexion auto à Supabase) qui s'exécute à chaque ouverture normale.
    const migrated = migrateTrackLikeWishlistEntries();
    if (migrated) toast(`${migrated} entrée${migrated>1?'s':''} de la wishlist déplacée${migrated>1?'s':''} vers les morceaux ✓`);
    const cleanedCorrupted = cleanupCorruptedWishlistEntries();
    if (cleanedCorrupted) toast(`${cleanedCorrupted} entrée${cleanedCorrupted>1?'s':''} corrompue${cleanedCorrupted>1?'s':''} ("[object Object]") retirée${cleanedCorrupted>1?'s':''} de la wishlist ✓`);
    pruneWishlistOwned();
    renderAlbums(); renderTracks(); updateNavBadges();
    setSaveIndicator('saved');
    toast(loaded ? '🟢 Supabase connecté' : '🟢 Supabase connecté — importe ton XML MusicBee pour peupler la collection');
    setTimeout(() => autoSyncLastfm(), 2000);
    return true;
  } catch(e) {
    if (errEl) errEl.textContent = 'Erreur : ' + (e.message || String(e));
    window._sb = null;
    return false;
  }
}

function skipSupabase() {
  document.getElementById('supabase-setup').style.display = 'none';
  localStorage.setItem(LS_CFG, 'skip');
  initApp();
}

// Chunk helper : Supabase limite les upserts à ~500 lignes
// Dédoublonne par clé de conflit avant envoi pour éviter "ON CONFLICT DO UPDATE command cannot affect row a second time"
async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  // Dédoublonner par clé de conflit (peut être composite : "a,b")
  const conflictCols = onConflict.split(',').map(c => c.trim());
  const seen = new Map();
  rows.forEach(r => {
    const k = conflictCols.map(c => String(r[c] ?? '')).join('|||');
    // Garder la dernière occurrence (plus récente)
    seen.set(k, r);
  });
  const deduped = [...seen.values()];
  const size = 400;
  for (let i = 0; i < deduped.length; i += size) {
    const { error } = await window._sb.from(table).upsert(deduped.slice(i, i + size), { onConflict });
    if (error) throw error;
  }
}

// Dédoublonner le tableau albums en mémoire
// Utilise artistVariants pour fusionner ex. "Various" et "Various Artists", "EELS" et "Eels"
// GARDE-FOU HOMONYMES : deux albums peuvent partager le même artiste+titre normalisé sans
// être le même album (ex: "Weezer" — Weezer, l'album bleu de 1994 ET l'album vert de 2001).
// On ne fusionne QUE si rien ne prouve qu'il s'agit de deux albums distincts : si les deux
// ont un discogsId différent, un mb_release_id différent, ou une année différente (quand les
// deux sont renseignées), on les laisse séparés même si le titre est identique.
function albumsLookLikeHomonyms(a, b) {
  if (a.discogsId && b.discogsId && a.discogsId !== b.discogsId) return true;
  if (a.mb_release_id && b.mb_release_id && a.mb_release_id !== b.mb_release_id) return true;
  if (a.year && b.year && a.year.slice(0,4) !== b.year.slice(0,4)) return true;
  return false;
}

function deduplicateAlbums() {
  const seen = new Map();    // clé normalisée (variante) → entrée retenue
  const dropped = new Set(); // albums fusionnés, à retirer explicitement à la fin
  const before = albums.length;
  let homonymsSkipped = 0;

  albums.forEach(a => {
    if (dropped.has(a)) return; // déjà absorbé par un doublon traité plus tôt dans cette passe
    const albumNorm = normalizeKey('', a.album).replace('|||', '');
    let merged = false;

    for (const av of artistVariants(a.artist)) {
      const k = av + '|||' + albumNorm;
      const prev = seen.get(k);
      if (prev && prev !== a) {
        if (albumsLookLikeHomonyms(prev, a)) {
          homonymsSkipped++;
          continue; // cette variante précise est bloquée — essayer les autres variantes d'artiste
        }
        // Fusionner : garder l'id le plus élevé (le plus récent), fusionner les formats
        const keep = a.id > prev.id ? a : prev;
        const drop = keep === a ? prev : a;
        keep.cd      = keep.cd      || drop.cd;
        keep.flac    = keep.flac    || drop.flac;
        keep.mp3     = keep.mp3     || drop.mp3;
        keep.digital = keep.digital || drop.digital;
        if (!keep.discogsId && drop.discogsId) keep.discogsId = drop.discogsId;
        if (!keep.year  && drop.year)  keep.year  = drop.year;
        if (!keep.genre && drop.genre) keep.genre = drop.genre;
        if (!keep.note  && drop.note)  keep.note  = drop.note;
        // Repointer les associations qui référençaient la fiche supprimée, pour éviter de
        // laisser des associations CD↔numérique / RYM orphelines après la fusion
        associations.forEach(x => {
          if (x.cdKey === drop.id) x.cdKey = keep.id;
          if (x.numKey === drop.id) x.numKey = keep.id;
        });
        rymAssociations.forEach(x => { if (x.albumKey === drop.id) x.albumKey = keep.id; });
        dropped.add(drop);
        // Réindexer toutes les variantes de keep pour que les albums suivants le retrouvent
        for (const av2 of artistVariants(keep.artist)) seen.set(av2 + '|||' + albumNorm, keep);
        merged = true;
        break;
      }
    }

    if (!merged) {
      // Nouvelle entrée (ou homonyme volontairement distinct) : n'indexer que les variantes
      // encore libres, sans jamais écraser une entrée homonyme déjà indexée
      for (const av of artistVariants(a.artist)) {
        const k = av + '|||' + albumNorm;
        if (!seen.has(k)) seen.set(k, a);
      }
    }
  });

  albums = albums.filter(a => !dropped.has(a));
  if (homonymsSkipped) console.log(`Dédoublonnage : ${homonymsSkipped} homonyme(s) distinct(s) préservé(s) (discogsId/mb_release_id/année différents)`);
  if (albums.length < before) console.log(`Dédoublonnage : ${before - albums.length} doublons supprimés`);
}

let _savingToSupabase = false;
// Bug corrigé v2026.07.10-20 : pendant une restauration de snapshot, ce flag bloque toute purge
// automatique (pruneWishlistOwned/pruneNotesToReport, déclenchées par updateNavBadges) tant que
// l'état restauré n'a pas fini d'être persisté — voir restoreSnapshot() pour le détail de la
// race condition corrigée.
let _restoringSnapshot = false;
async function saveToSupabase(opts) {
  const force = !!(opts && opts.force);
  if (!window._sb) return;
  if (_savingToSupabase) { 
    // Relancer après la sauvegarde en cours
    setTimeout(() => saveToSupabase(opts), 1000);
    return;
  }
  // Bug corrigé v2026.07.10-29 : le verrou était posé APRÈS l'await de fetchSyncState()
  // ci-dessous — fenêtre de course où plusieurs appels saveToSupabase() déclenchés à
  // quelques ms d'intervalle (plusieurs actions UI coup sur coup) passaient TOUS le test
  // ci-dessus pendant que _savingToSupabase valait encore false, puis exécutaient chacun
  // indépendamment le diff destructeur (DELETE des absents) sur le même état remote pas
  // encore modifié — d'où plusieurs snapshots auto "avant suppression de N album(s)"
  // quasi identiques (signalé par Antoine avec capture d'écran, 3 doublons à 5-7s
  // d'intervalle, systématiquement le même N). Posé ici, avant tout await, pour que
  // les appels concurrents soient bloqués dès le test initial comme prévu.
  _savingToSupabase = true;
  // ── Détection de conflit (v2026.07.09) ──────────────────────────────────────
  // Si un autre onglet/appareil a sauvegardé depuis notre dernier chargement, on bloque
  // le sync destructeur (DELETE des absents, etc.) plutôt que d'écraser silencieusement.
  // `force` (bouton "Forcer l'écrasement" de la modale de conflit) court-circuite ce check.
  let expectedVersion = null;
  if (!force) {
    const remoteState = await fetchSyncState();
    if (remoteState && _localSyncVersion !== null && remoteState.version !== _localSyncVersion) {
      _syncConflict = { remoteVersion: remoteState.version, remoteDeviceLabel: remoteState.device_label || 'un autre appareil', remoteAt: remoteState.updated_at };
      setSaveIndicator('conflict');
      _savingToSupabase = false; // pas de finally atteint sur ce retour anticipé — reset manuel
      return; // sync bloqué — aucune table modifiée
    }
    if (remoteState) expectedVersion = remoteState.version;
  }
  setSaveIndicator('saving');
  const now = new Date().toISOString();

  try {
    // ── Albums (inclut stock, ok, forsale — distingués par folders[]) ──────────
    const albumRows = albums.map(a => ({
      id:             a.id,
      artist:         a.artist,
      album:          a.album,
      year:           a.year || null,
      genre:          a.genre || null,
      folders:        JSON.stringify(a.folders || []),
      has_cd:         !!(a.has_cd || a.cd),
      format:         a.format || null,
      note:           a.note || 0,
      plays:          a.plays || 0,
      notes:          a.notes || null,
      discogs_id:     a.discogsId || null,
      discogs_rating: a.discogsRating || null,
      mb_release_id:  a.mb_release_id || null,
      mb_match_score: a.mb_match_score ?? null,
      mb_original_year: a.mb_original_year || null,
      mb_refreshed_at: a.mb_refreshed_at || null,
      mb_release_type: a.mb_release_type || null,
      mb_release_secondary_types: a.mb_release_secondary_types?.length ? JSON.stringify(a.mb_release_secondary_types) : null,
      mb_credits: a.mb_credits?.length ? JSON.stringify(a.mb_credits) : null,
      discogs_master_year: a.discogs_master_year || null,
      marketplace_price: a.marketplace_price ?? null,
      marketplace_currency: a.marketplace_currency || null,
      marketplace_num_for_sale: a.marketplace_num_for_sale ?? null,
      marketplace_fetched_at: a.marketplace_fetched_at || null,
      youtube_url:    a.youtube_url || null,
      cover_url:      a.cover_url || null,
      lastfm_aliases: a.lastfmAliases?.length ? JSON.stringify(a.lastfmAliases) : null,
      merged_aliases: a.mergedAliases?.length ? JSON.stringify(a.mergedAliases) : null,
      label:          a.label || null,
      catno:          a.catno || null,
      is_compilation: !!a.isCompilation,
      loaned_to:      a.loaned_to || null,
      loaned_since:   a.loaned_since || null,
	  primary_folder: a.primaryFolder || 'album',
      field_provenance: a.field_provenance ? JSON.stringify(a.field_provenance) : null,
      updated_at:     now,
    }));
    // Remplacement complet : DELETE absents puis upsert
    await sbUpsert('albums', albumRows, 'id');
    // Purger les IDs Supabase absents localement
    const localIds = new Set(albums.map(a => a.id));
    let remoteIds = [], rp = 0;
    while (true) {
      const { data: batch } = await window._sb.from('albums').select('id')
        .range(rp * 1000, (rp + 1) * 1000 - 1);
      if (!batch || !batch.length) break;
      remoteIds = remoteIds.concat(batch.map(r => r.id));
      if (batch.length < 1000) break; rp++;
    }
    const toDelete = remoteIds.filter(id => !localIds.has(id));
    await autoSnapshotBeforeDelete(toDelete.length);
    for (let i = 0; i < toDelete.length; i += 200) {
      await window._sb.from('albums').delete().in('id', toDelete.slice(i, i + 200));
    }
    if (toDelete.length) console.log(`Supabase : ${toDelete.length} albums supprimés`);

    // ── Tracks isolés (PK composite artist_norm+title_norm) ──────────────────
    // Dédoublonner par PK avant upsert
    const trackDedup = new Map();
    tracks.forEach(t => {
      const an = t.artistNorm || normalizeKey(t.artist, '').replace('|||', '');
      const tn = t.titleNorm  || normalizeKey('', t.title).replace('|||', '');
      const k = an + '|||' + tn;
      const prev = trackDedup.get(k);
      if (!prev || (t.note || 0) > (prev.note || 0)) trackDedup.set(k, t);
    });
    const trackRows = [...trackDedup.values()].map(t => ({
      artist_norm:     t.artistNorm || normalizeKey(t.artist, '').replace('|||', ''),
      title_norm:      t.titleNorm  || normalizeKey('', t.title).replace('|||', ''),
      artist:          t.artist,
      title:           t.title,
      album:           t.album || null,
      format:          t.format || null,
      duration:        t.duration || null,
      note:            t.note || 0,
      mb_recording_id: t.mb_recording_id || null,
      bitrate:         t.bitrate || null,
      updated_at:      now,
    }));
    if (trackRows.length) await sbUpsert('tracks', trackRows, 'artist_norm,title_norm');

    // ── Associations Discogs↔numérique (clés texte) ───────────────────────────
    if (associations.length) {
      await window._sb.from('associations').delete().neq('cd_key', '___never___');
      await sbUpsert('associations', associations.map(a => ({ cd_key: a.cdKey, num_key: a.numKey })), 'cd_key,num_key');
    }

    // ── Associations RYM (clés texte) ─────────────────────────────────────────
    if (rymAssociations.length) {
      await window._sb.from('rym_associations').delete().neq('rym_key', '___never___');
      await sbUpsert('rym_associations', rymAssociations.map(a => ({ rym_key: a.rymKey, album_key: a.albumKey })), 'rym_key');
    }

    // ── lastfmData ────────────────────────────────────────────────────────────
    // Dédoublonnage par clé NORMALISÉE (pas texte brut) : "Luck In The Valley" et
    // "Luck in the Valley" doivent fusionner en une seule ligne, écoutes additionnées,
    // sinon Postgres (conflict sur artist,album en texte brut, sensible à la casse)
    // les traite comme deux albums distincts et les doublons s'accumulent à chaque save.
    if (lastfmData.length) {
      const lfDedup = new Map();
      lastfmData.forEach(d => {
        if (!d.artist || !d.album) return;
        const k = normalizeKey(d.artist, d.album);
        const prev = lfDedup.get(k);
        if (!prev) {
          lfDedup.set(k, { artist: d.artist, album: d.album, plays: d.plays || 0, _bestPlays: d.plays || 0 });
        } else {
          prev.plays += (d.plays || 0);
          if ((d.plays || 0) > prev._bestPlays) {
            prev._bestPlays = d.plays || 0;
            prev.artist = d.artist;
            prev.album = d.album;
          }
        }
      });
      lastfmData = [...lfDedup.values()].map(({ artist, album, plays }) => ({ artist, album, plays }));
      const lfRows = lastfmData.map(d => ({ artist: d.artist, album: d.album, plays: d.plays || 0, updated_at: now }));
      await sbUpsert('lastfm_data', lfRows, 'artist,album');
    }

    // ── rymData ───────────────────────────────────────────────────────────────
    if (rymData.length) {
      const rymRows = rymData.map(d => ({
        artist: d.artist, album: d.album, rating: d.rating,
        ownership: d.ownership || null, year: d.year || null, genre: d.genre || null, updated_at: now
      }));
      await sbUpsert('rym_data', rymRows, 'artist,album');
    }

    // ── Meta ──────────────────────────────────────────────────────────────────
    const wishData = JSON.stringify({ albums: wishlist, tracks: trackWishlist });
    await window._sb.from('meta').upsert([
      { key: 'wishlist_data', value: wishData },
      { key: 'notes_to_report_data', value: JSON.stringify(notesToReport) },
      { key: 'track_note_overrides_data', value: JSON.stringify(trackNoteOverrides) },
      { key: 'track_youtube_cache_data', value: JSON.stringify(trackYoutubeCache) },
      { key: 'listening_evolution_data', value: JSON.stringify({ data: listeningEvolution, computedAt: _listeningEvolutionComputedAt }) },
      { key: 'listening_heatmap_data', value: JSON.stringify({ data: listeningHeatmap, computedAt: _listeningHeatmapComputedAt }) },
      { key: 'genre_evolution_data', value: JSON.stringify({ data: genreEvolution, computedAt: _genreEvolutionComputedAt }) },
      { key: 'market_value_history_data', value: JSON.stringify(marketValueHistory) },
    ], { onConflict: 'key' });

    // ── Bump atomique du compteur de version (v2026.07.09) ────────────────────
    // Update conditionnel (WHERE version = expectedVersion) : si une autre écriture s'est
    // glissée entre le check du début et maintenant, 0 ligne est modifiée — on retombe sur
    // un simple re-fetch (dernier écrivain gagne pour cette fenêtre étroite, comme avant),
    // sans bloquer l'utilisateur puisque ses propres données viennent d'être écrites avec succès.
    if (!_syncTableMissing) {
      try {
        const bumpPayload = { updated_at: now, device_id: getDeviceId(), device_label: getDeviceLabel() };
        let newVersion = null;
        if (expectedVersion !== null) {
          const { data: bumped } = await window._sb.from('sync_state')
            .update({ version: expectedVersion + 1, ...bumpPayload })
            .eq('id', 1).eq('version', expectedVersion)
            .select('version').single();
          newVersion = bumped ? bumped.version : null;
        }
        if (newVersion === null) {
          // Pas de version attendue (1ère connexion), update conditionnel raté (course), OU ligne
          // id=1 absente (jamais seedée) : upsert plutôt qu'update, pour que la ligne se crée
          // d'elle-même au lieu de laisser le compteur durablement désactivé. Bug corrigé
          // v2026.07.10-20 : une ligne sync_state manquante faisait échouer l'UPDATE en silence
          // (0 ligne affectée → 406 sur .single()) à CHAQUE sauvegarde, avec pour conséquence que
          // la protection anti-écrasement multi-onglets n'a jamais pu s'activer une seule fois.
          const cur = await fetchSyncState();
          const base = cur ? cur.version : 0;
          const { data: bumped2 } = await window._sb.from('sync_state')
            .upsert({ id: 1, version: base + 1, ...bumpPayload }, { onConflict: 'id' })
            .select('version').single();
          newVersion = bumped2 ? bumped2.version : base + 1;
        }
        _localSyncVersion = newVersion;
        _syncConflict = null;
        // Même persistance qu'après un chargement (syncVersionAfterLoad()) — après un save
        // réussi, le cache local qu'on vient d'écrire (writeLocalCache(), appelé juste avant
        // saveToSupabase() dans _saveToStorageImpl()) reflète exactement cette nouvelle version :
        // pas besoin de retélécharger au prochain lancement tant que rien d'autre n'a resauvé.
        try { if (newVersion !== null) localStorage.setItem(LS_SYNC_VERSION_CACHE, String(newVersion)); } catch(e) {}
      } catch (e) {
        // Erreur réseau ponctuelle, ou table sync_state réellement absente (migration non
        // appliquée) — déjà détectée et flaggée par fetchSyncState() dans ce cas précis
        // (_syncTableMissing). On n'écrase plus ce flag ici pour toute autre erreur (RLS, etc.),
        // qui reste diagnostiquable via ce warning au lieu de désactiver silencieusement la
        // protection anti-conflit pour le reste de la session.
        console.warn('sync_state : échec du bump de version (protection anti-conflit potentiellement inactive) —', e.message || e);
      }
    }

    setSaveIndicator('saved', now);
  } catch(e) {
    setSaveIndicator('error');
    console.error('Supabase save error:', e);
  } finally {
    _savingToSupabase = false;
  }
}

async function loadFromSupabase() {
  if (!window._sb) return false;
  try {
    // ── Albums (paginé) ───────────────────────────────────────────────────────
    let alb = [], albPage = 0;
    while (true) {
      const { data: batch, error: e1 } = await window._sb
        .from('albums').select('*').order('id')
        .range(albPage * 1000, (albPage + 1) * 1000 - 1);
      if (e1) throw e1;
      if (!batch || !batch.length) break;
      alb = alb.concat(batch);
      if (batch.length < 1000) break;
      albPage++;
    }
    if (!alb.length) {
      // Table vide = après migration ou première utilisation — pas une erreur
      console.log('Albums table vide — prêt pour import XML');
      stockItems = [];
      // Charger quand même les associations, meta, lastfm depuis Supabase
      const { data: assoc } = await window._sb.from('associations').select('*');
      associations = (assoc || []).map(a => ({ cdKey: a.cd_key, numKey: a.num_key }));
      const { data: rymAssoc } = await window._sb.from('rym_associations').select('*');
      rymAssociations = (rymAssoc || []).map(a => ({ rymKey: a.rym_key, albumKey: a.album_key }));
      const { data: metaRows } = await window._sb.from('meta').select('key,value');
      if (metaRows) {
        const metaMap = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
        if (metaMap.lastfm_sync_ts) localStorage.setItem(LASTFM_SYNC_KEY, metaMap.lastfm_sync_ts);
        if (metaMap.wishlist_data) { try { const wd = JSON.parse(metaMap.wishlist_data); if (wd.albums?.length) wishlist = wd.albums; if (wd.tracks?.length) trackWishlist = wd.tracks; } catch(e) {} }
        if (metaMap.notes_to_report_data) { try { notesToReport = JSON.parse(metaMap.notes_to_report_data) || []; } catch(e) {} }
        if (metaMap.track_note_overrides_data) { try { trackNoteOverrides = JSON.parse(metaMap.track_note_overrides_data) || {}; } catch(e) {} }
        if (metaMap.track_youtube_cache_data) { try { trackYoutubeCache = JSON.parse(metaMap.track_youtube_cache_data) || {}; } catch(e) {} }
        if (metaMap.listening_evolution_data) { try { const le = JSON.parse(metaMap.listening_evolution_data); listeningEvolution = le.data || []; _listeningEvolutionComputedAt = le.computedAt || null; } catch(e) {} }
        if (metaMap.listening_heatmap_data) { try { const lh = JSON.parse(metaMap.listening_heatmap_data); listeningHeatmap = lh.data || []; _listeningHeatmapComputedAt = lh.computedAt || null; } catch(e) {} }
        if (metaMap.genre_evolution_data) { try { const ge = JSON.parse(metaMap.genre_evolution_data); genreEvolution = ge.data || []; _genreEvolutionComputedAt = ge.computedAt || null; } catch(e) {} }
        if (metaMap.market_value_history_data) { try { marketValueHistory = JSON.parse(metaMap.market_value_history_data) || []; } catch(e) {} }
        if (metaMap.lastfm_status) { try { _lastfmStatus = JSON.parse(metaMap.lastfm_status) || {}; } catch(e) {} }
        if (metaMap.lastfm_track_status) { try { _lastfmTrackStatus = JSON.parse(metaMap.lastfm_track_status) || {}; } catch(e) {} }
        if (metaMap.lastfm_loved) { try { _lovedTracks = new Set(JSON.parse(metaMap.lastfm_loved)); } catch(e) {} }
      }
      loadLastfmFromSupabase();
      const { data: rym } = await window._sb.from('rym_data').select('*');
      rymData = (rym || []).map(d => ({ artist: d.artist, album: d.album, rating: d.rating, ownership: d.ownership || '', year: d.year || '', genre: d.genre || '' }));
      nextId = Math.max(nextId, computeNextId());
      if (repairDuplicateIds()) saveToStorage();
      await syncVersionAfterLoad();
      writeLocalCache();
      setSaveIndicator('saved');
      return true; // succès — collection vide est un état valide
    }

    albums = alb.map(a => {
      let folders = [];
      try { folders = JSON.parse(a.folders || '[]'); } catch(e) {}
      return {
        id:            a.id,
        artist:        a.artist,
        album:         a.album,
        year:          a.year || '',
        genre:         a.genre || '',
        folders:       folders,
        has_cd:        !!a.has_cd,
        format:        a.format || '',
        note:          a.note || 0,
        plays:         a.plays || 0,
        notes:         a.notes || '',
        discogsId:     a.discogs_id || undefined,
        discogsRating: a.discogs_rating || undefined,
        mb_release_id: a.mb_release_id || undefined,
        mb_match_score: a.mb_match_score ?? undefined,
        mb_original_year: a.mb_original_year || undefined,
        mb_refreshed_at: a.mb_refreshed_at || undefined,
        mb_release_type: a.mb_release_type || undefined,
        mb_release_secondary_types: (() => { try { return a.mb_release_secondary_types ? JSON.parse(a.mb_release_secondary_types) : undefined; } catch(e) { return undefined; } })(),
        mb_credits: (() => { try { return a.mb_credits ? JSON.parse(a.mb_credits) : undefined; } catch(e) { return undefined; } })(),
        discogs_master_year: a.discogs_master_year || undefined,
        marketplace_price: a.marketplace_price ?? undefined,
        marketplace_currency: a.marketplace_currency || undefined,
        marketplace_num_for_sale: a.marketplace_num_for_sale ?? undefined,
        marketplace_fetched_at: a.marketplace_fetched_at || undefined,
        youtube_url:   a.youtube_url || undefined,
        cover_url:     a.cover_url || undefined,
        lastfmAliases: a.lastfm_aliases ? JSON.parse(a.lastfm_aliases) : undefined,
        mergedAliases: a.merged_aliases ? JSON.parse(a.merged_aliases) : undefined,
        label:         a.label || undefined,
        catno:         a.catno || undefined,
        isCompilation: !!a.is_compilation,
        loaned_to:     a.loaned_to || undefined,
        loaned_since:  a.loaned_since || undefined,
		primaryFolder: a.primary_folder || 'album',
        field_provenance: (() => { try { return a.field_provenance ? JSON.parse(a.field_provenance) : undefined; } catch(e) { return undefined; } })(),
		
        // Compat lecture ancienne UI
        cd:      !!a.has_cd,
		has_cd:  !!a.has_cd,
		flac:    a.format === 'flac',
		mp3:     a.format === 'mp3',
		digital: a.format === 'digital',
        okFolder:  folders.includes('ok'),
        forSale:   folders.includes('forsale'),
		primaryFolder: a.primary_folder || 'album',
      };
    });
    // Nettoyage cover_url coverartarchive
    albums.forEach(a => { if (a.cover_url?.includes('coverartarchive')) a.cover_url = undefined; });
    // ── Migration folders[] : l'ancien code pushait 'discographie' pour TOUS les albums normaux ──
    // Désormais 'discographie' = dossier F:/music/Discographie/ détecté via XML
    // Les albums avec folders=['discographie'] mais sans CD ni format numérique = faux positifs
    // On les migre vers ['album'] (tag générique pour "album numérique hors dossiers spéciaux")
    // Note : on ne touche pas aux albums qui ont aussi 'stock', 'ok', 'forsale'
    let migratedCount = 0;
	// Migration primaryFolder depuis folders[]
	albums.forEach(a => {
	if (!a.primaryFolder || a.primaryFolder === 'album') {
		if (a.folders?.includes('stock'))      a.primaryFolder = 'stock';
		else if (a.folders?.includes('ok'))    a.primaryFolder = 'ok';
		else if (a.folders?.includes('forsale')) a.primaryFolder = 'forsale';
		else if (a.folders?.includes('discographie')) a.primaryFolder = 'discographie';
	}
});
    albums.forEach(a => {
      if (!a.folders) { a.folders = ['album']; return; }
      const hasSpecial = a.folders.some(f => ['stock','ok','forsale'].includes(f));
      if (!hasSpecial && a.folders.includes('discographie') && !a.cd && !a.has_cd) {
        // Cet album avait 'discographie' poussé par l'ancien code (pas de CD Discogs)
        // Conserver 'discographie' uniquement si format numérique détecté (vrai album numérique)
        // Sans format -> était un album Discogs-only mal tagué -> passer à 'album'
        if (!a.format && !a.flac && !a.mp3 && !a.digital) {
          a.folders = a.folders.map(f => f === 'discographie' ? 'album' : f);
          migratedCount++;
        }
      }
    });
    if (migratedCount) console.log(`Migration folders : ${migratedCount} albums 'discographie' → 'album'`);
    // Reconstruire stockItems pour compat UI
    stockItems = albums.filter(a => a.folders.includes('stock'));
    console.log(`Albums chargés : ${albums.length} (dont ${stockItems.length} en stock)`);

    // ── Tracks isolés ────────────────────────────────────────────────────────
    let trkAll = [], trkPage = 0;
    while (true) {
      const { data: batch } = await window._sb.from('tracks').select('*')
        .range(trkPage * 1000, (trkPage + 1) * 1000 - 1);
      if (!batch || !batch.length) break;
      trkAll = trkAll.concat(batch);
      if (batch.length < 1000) break;
      trkPage++;
    }
    tracks = trkAll.map(t => ({
      id:              t.artist_norm + '|||' + t.title_norm, // pseudo-id pour compat UI
      artistNorm:      t.artist_norm,
      titleNorm:       t.title_norm,
      artist:          t.artist,
      title:           t.title,
      album:           t.album || '',
      format:          t.format || 'flac',
      duration:        t.duration || '',
      note:            t.note || 0,
      mb_recording_id: t.mb_recording_id || undefined,
      bitrate:         t.bitrate || undefined,
    }));

    // ── Associations (clés texte) ─────────────────────────────────────────────
    const { data: assoc } = await window._sb.from('associations').select('*');
    associations = (assoc || []).map(a => ({ cdKey: a.cd_key, numKey: a.num_key }));

    const { data: rymAssoc } = await window._sb.from('rym_associations').select('*');
    rymAssociations = (rymAssoc || []).map(a => ({ rymKey: a.rym_key, albumKey: a.album_key }));

    // ── lastfmData (arrière-plan) ─────────────────────────────────────────────
    loadLastfmFromSupabase();

    // ── rymData ───────────────────────────────────────────────────────────────
    let rymAll = [], rymPage = 0;
    while (true) {
      const { data: rymBatch } = await window._sb.from('rym_data').select('*')
        .range(rymPage * 1000, (rymPage + 1) * 1000 - 1);
      if (!rymBatch || !rymBatch.length) break;
      rymAll = rymAll.concat(rymBatch);
      if (rymBatch.length < 1000) break;
      rymPage++;
    }
    rymData = rymAll.map(d => ({
      artist: d.artist, album: d.album, rating: d.rating,
      ownership: d.ownership || '', year: d.year || '', genre: d.genre || ''
    }));
    // Reconstruire l'index immédiatement (version riche avec variantes artiste)
    delete _cache.rymIndex;
    getRymIndex();
    updateNavBadges();
    if (document.getElementById('sec-missing')?.classList.contains('active')) {
      renderMissing();
    } // forcer la reconstruction avec les données complètes

    // ── Meta ──────────────────────────────────────────────────────────────────
    const { data: metaRows } = await window._sb.from('meta').select('key,value');
    if (metaRows) {
      const metaMap = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
      if (metaMap.lastfm_sync_ts) localStorage.setItem(LASTFM_SYNC_KEY, metaMap.lastfm_sync_ts);
      if (metaMap.wishlist_data) {
        try {
          const wd = JSON.parse(metaMap.wishlist_data);
          if (wd.albums?.length) wishlist = wd.albums;
          if (wd.tracks?.length) trackWishlist = wd.tracks;
        } catch(e) {}
      }
      if (metaMap.notes_to_report_data) {
        try { notesToReport = JSON.parse(metaMap.notes_to_report_data) || []; } catch(e) {}
      }
      if (metaMap.track_note_overrides_data) {
        try { trackNoteOverrides = JSON.parse(metaMap.track_note_overrides_data) || {}; } catch(e) {}
      }
      if (metaMap.track_youtube_cache_data) {
        try { trackYoutubeCache = JSON.parse(metaMap.track_youtube_cache_data) || {}; } catch(e) {}
      }
      if (metaMap.listening_evolution_data) {
        try { const le = JSON.parse(metaMap.listening_evolution_data); listeningEvolution = le.data || []; _listeningEvolutionComputedAt = le.computedAt || null; } catch(e) {}
      }
      if (metaMap.listening_heatmap_data) {
        try { const lh = JSON.parse(metaMap.listening_heatmap_data); listeningHeatmap = lh.data || []; _listeningHeatmapComputedAt = lh.computedAt || null; } catch(e) {}
      }
      if (metaMap.genre_evolution_data) {
        try { const ge = JSON.parse(metaMap.genre_evolution_data); genreEvolution = ge.data || []; _genreEvolutionComputedAt = ge.computedAt || null; } catch(e) {}
      }
      if (metaMap.market_value_history_data) {
        try { marketValueHistory = JSON.parse(metaMap.market_value_history_data) || []; } catch(e) {}
      }
      if (metaMap.lastfm_status) {
        try { _lastfmStatus = JSON.parse(metaMap.lastfm_status) || {}; } catch(e) {}
      }
      if (metaMap.lastfm_track_status) {
        try { _lastfmTrackStatus = JSON.parse(metaMap.lastfm_track_status) || {}; } catch(e) {}
      }
      if (metaMap.lastfm_loved) {
        try {
          const arr = JSON.parse(metaMap.lastfm_loved);
          _lovedTracks = new Set(arr);
          try { localStorage.setItem('lastfm_loved', metaMap.lastfm_loved); } catch(e) {}
          const countEl = document.getElementById('lastfm-loved-count');
          if (countEl && _lovedTracks.size) countEl.textContent = `❤️ ${_lovedTracks.size} morceaux`;
        } catch(e) {}
      }
    }
    setTimeout(() => updateLastSyncLabel(), 100);
    loadAlbumTracks();
    loadMusicBeeTracks();
    setTimeout(() => fetchMissingCovers(), 3000);
    nextId = Math.max(nextId, computeNextId());
    if (repairDuplicateIds()) saveToStorage();

    await syncVersionAfterLoad();
    writeLocalCache();
    setSaveIndicator('saved');
    return true;
  } catch(e) {
    console.error('Supabase load error:', e);
    return false;
  }
}

async function loadLastfmFromSupabase() {
  if (!window._sb) return;
  try {
    // Charger lastfm_data (albums) par pages de 1000
    let all = [], page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await window._sb
        .from('lastfm_data').select('artist,album,plays')
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error || !data || !data.length) break;
      all = all.concat(data);
      if (data.length < pageSize) break;
      page++;
    }
    lastfmData = all.map(d => ({ artist: d.artist, album: d.album, plays: d.plays }));

    // Charger lastfm_tracks (morceaux) en arrière-plan
    // La table peut ne pas encore exister (404 PGRST205) — on ignore silencieusement
    (async () => {
      try {
        let trackAll = [], tp = 0;
        while (true) {
          const { data, error } = await window._sb
            .from('lastfm_tracks').select('artist,track,album,plays')
            .range(tp * pageSize, (tp + 1) * pageSize - 1);
          // 404 / PGRST205 = table inexistante → arrêter sans erreur
          if (error) {
            if (error.code === 'PGRST205' || error.message?.includes('relation') || error.message?.includes('does not exist')) {
              console.info('lastfm_tracks : table non créée — exécutez le SQL fourni dans Supabase');
            } else {
              console.warn('lastfm_tracks :', error);
            }
            break;
          }
          if (!data || !data.length) break;
          trackAll = trackAll.concat(data);
          if (data.length < pageSize) break;
          tp++;
        }
        if (trackAll.length) {
          _lastfmTrackCounts = {};
          trackAll.forEach(d => {
            const kt = normalizeKey(d.artist, d.track) + '|' + normalizeKey('', d.album || '');
            _lastfmTrackCounts[kt] = { artist: d.artist, track: d.track, album: d.album || '', plays: d.plays };
          });
          console.log(`lastfm_tracks chargés : ${trackAll.length} morceaux`);
          writeLastfmTracksCache();
          // Invalider le cache et mettre à jour les onglets qui dépendent des tracks
          invalidateCache();
          updateNavBadges();
          if (document.getElementById('sec-tracks')?.style.display !== 'none') renderTracks();
          if (document.getElementById('sec-missing-tracks')?.style.display !== 'none') renderMissingTracks();
        }
      } catch(e) { console.warn('lastfm_tracks (ignoré):', e); }
    })();
    invalidateCache();
    // Indexer les albums par clé normalisée une seule fois (O(n) au lieu de O(n²))
    const albumIndex = new Map();
    albums.forEach(a => {
      albumIndex.set(normalizeKey(a.artist, a.album), a);
      // Aussi indexer avec l'artiste nettoyé Discogs
      const cleanKey = normalizeKey(cleanDiscogsArtist(a.artist), a.album);
      if (!albumIndex.has(cleanKey)) albumIndex.set(cleanKey, a);
    });
    // Appliquer les plays par lots pour ne pas bloquer le thread
    const CHUNK = 2000;
    async function applyPlaysChunked(i) {
      const end = Math.min(i + CHUNK, lastfmData.length);
      for (; i < end; i++) {
        const d = lastfmData[i];
        const a = albumIndex.get(normalizeKey(d.artist, d.album));
        if (a) a.plays = d.plays;
      }
      if (i < lastfmData.length) {
        await new Promise(r => setTimeout(r, 0)); // yield au navigateur
        await applyPlaysChunked(i);
      } else {
        _dataReady = true;
        updateNavBadges();
      }
    }
    await applyPlaysChunked(0);
  } catch(e) { loadLastfmFromLocalStorage(); }
}

function loadLastfmFromLocalStorage() {
  try {
    const raw = localStorage.getItem('discotheque_lastfm');
    if (!raw) return;
    // Nouveau format délimité \x1f (v2026.07.12-15) ; repli sur l'ancien format JSON si un
    // cache pré-existant de l'ancien format traîne encore (transition, se réécrit tout seul
    // au prochain saveToStorage()).
    if (raw[0] === '[') {
      const compact = JSON.parse(raw);
      lastfmData = compact.map(d => ({ artist: d.a || d.artist, album: d.b || d.album, plays: d.p || d.plays }));
    } else {
      lastfmData = raw.split('\n').filter(Boolean).map(line => {
        const [artist, album, plays] = line.split('\x1f');
        return { artist, album, plays: parseInt(plays, 10) || 0 };
      });
    }
  } catch(e) {}
}

// Restaure _lastfmTrackCounts depuis le cache localStorage (format délimité \x1f, voir
// writeLastfmTracksCache() — v2026.07.12-15) — reconstruit le même format de clé que
// loadLastfmFromSupabase()/importLastfmTracks() pour rester interchangeable.
function loadLastfmTracksFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_LASTFM_TRACKS_KEY);
    if (!raw) return false;
    const counts = {};
    raw.split('\n').forEach(line => {
      if (!line) return;
      const [artist, track, album, plays] = line.split('\x1f');
      if (!artist || !track) return;
      const kt = normalizeKey(artist, track) + '|' + normalizeKey('', album || '');
      counts[kt] = { artist, track, album: album || '', plays: parseInt(plays, 10) || 0 };
    });
    // Ancien format (tableau JSON, jusqu'à v2026.07.12-14) tombe ici avec 0 entrée valide
    // (pas de \x1f dans un JSON) — repli propre sur false plutôt que de prétendre avoir chargé
    // un cache vide, l'appelant retombera sur le rechargement Supabase normal.
    if (!Object.keys(counts).length) return false;
    _lastfmTrackCounts = counts;
    return true;
  } catch(e) { return false; }
}


function loadRymFromLocalStorage() {
  try {
    const raw = localStorage.getItem('discotheque_rym');
    if (!raw) return;
    // Nouveau format délimité \x1f (v2026.07.12-15) ; repli sur l'ancien format JSON, même
    // logique de transition que loadLastfmFromLocalStorage() ci-dessus.
    if (raw[0] === '[') {
      const compact = JSON.parse(raw);
      rymData = compact.map(d => ({ artist: d.a || d.artist, album: d.b || d.album, rating: d.r || d.rating, ownership: d.o || d.ownership || '' }));
    } else {
      rymData = raw.split('\n').filter(Boolean).map(line => {
        const [artist, album, rating, ownership] = line.split('\x1f');
        return { artist, album, rating: parseFloat(rating) || 0, ownership: ownership || '' };
      });
    }
  } catch(e) {}
}

// ===================== INDICATOR =====================
function setSaveIndicator(state, isoDate) {
  const el = document.getElementById('save-indicator');
  const label = document.getElementById('save-label');
  if (!el) return;
  el.className = 'save-indicator ' + state;
  const isSupa = !!window._sb;
  if (state === 'saving') {
    label.textContent = isSupa ? '🟢 Sync…' : 'Sauvegarde…';
  } else if (state === 'saved') {
    const prefix = isSupa ? '🟢 ' : '';
    if (isoDate) {
      const d = new Date(isoDate);
      const diff = Math.floor((Date.now() - d) / 60000);
      if (diff < 1) label.textContent = prefix + 'Synchronisé';
      else if (diff < 60) label.textContent = prefix + `Sync il y a ${diff} min`;
      else label.textContent = prefix + d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
    } else { label.textContent = prefix + 'Synchronisé'; }
  } else if (state === 'error') {
    label.textContent = isSupa ? '🟢 Erreur sync' : 'Erreur sauvegarde';
  } else if (state === 'conflict') {
    label.textContent = '⚠️ Conflit — cliquer pour résoudre';
  } else {
    label.textContent = 'Aucune sauvegarde';
  }
  el.onclick = (state === 'conflict') ? openSyncConflictModal : null;
}

setInterval(() => {
  const raw = localStorage.getItem(LS_KEY);
  if (raw && !window._sb) { try { setSaveIndicator('saved', JSON.parse(raw).savedAt); } catch(e){} }
}, 60000);




function uid() { return nextId++; }

// ===================== INTÉGRITÉ DES IDS (uid()) =====================
// BUG CORRIGÉ (v2026.07.08-08) : nextId n'était recalculé qu'à partir de albums/tracks, jamais de
// wishlist/trackWishlist/notesToReport/stockItems — qui utilisent pourtant tous uid() pour leurs
// propres ids. Pire, dans loadFromSupabase() la ligne de recalcul mappait chaque track sur la
// CONSTANTE 1 (`tracks.map(t => 1)`, résidu de la migration des tracks vers des pseudo-ids texte
// qui a oublié de retirer le nextId basé dessus) au lieu de considérer les vrais ids numériques —
// nextId retombait donc à ~2 à CHAQUE chargement Supabase, quel que soit le nombre d'entrées déjà
// créées. Résultat : de nouveaux ajouts à la wishlist morceaux (et albums, et Notes à reporter)
// réutilisaient des ids déjà pris par d'anciennes entrées → plusieurs entrées partageant le même
// id → un seul clic "retirer" (filter par id) en supprimait plusieurs d'un coup.
function computeNextId() {
  const ids = [0];
  const addIds = arr => arr.forEach(x => { if (typeof x.id === 'number' && isFinite(x.id)) ids.push(x.id); });
  addIds(albums);
  addIds(wishlist);
  addIds(trackWishlist);
  addIds(notesToReport);
  return Math.max(...ids) + 1;
}

// Répare les ids dupliqués déjà présents (conséquence du bug ci-dessus) — ne touche jamais aux
// albums (dérivation risquée avec stockItems, quasiment jamais concerné par ce bug précis) ; ne
// réattribue un nouvel id qu'aux entrées wishlist/trackWishlist/notesToReport arrivées APRÈS un
// doublon déjà vu, en conservant la première occurrence intacte.
function repairDuplicateIds() {
  let fixed = 0;
  const seen = new Set();
  const fixArray = arr => {
    arr.forEach(item => {
      if (typeof item.id !== 'number') return;
      if (seen.has(item.id)) { item.id = uid(); fixed++; }
      else seen.add(item.id);
    });
  };
  fixArray(wishlist);
  fixArray(trackWishlist);
  fixArray(notesToReport);
  if (fixed) console.warn(`[repairDuplicateIds] ${fixed} id(s) dupliqué(s) réattribué(s) (wishlist/trackWishlist/notesToReport)`);
  return fixed;
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += c;
    }
    vals.push(cur);
    const obj = {};
    header.forEach((h, i) => obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''));
    return obj;
  });
}

function toCSVRow(vals) {
  return vals.map(v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsText(file, 'UTF-8');
  });
}

function genreList() {
  const s = new Set(albums.map(a => a.genre).filter(Boolean));
  return [...s].sort();
}

function artistList() {
  const s = new Set(albums.map(a => a.artist).filter(Boolean));
  return [...s].sort((a, b) => a.localeCompare(b, 'fr'));
}

function trackArtistList() {
  const s = new Set(tracks.map(t => t.artist).filter(Boolean));
  return [...s].sort((a, b) => a.localeCompare(b, 'fr'));
}

// Normalisation robuste pour la fusion Discogs/MusicBee/last.fm
function normalizeKey(artist, album) {
  const norm = s => {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/[\r\n\t]/g, ' ')  // retours chariot, tabulations → espace
      // Apostrophes typographiques → apostrophe ASCII puis suppression
      .replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'")
      // Tirets longs / demi-tirets → tiret simple
      .replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // Guillemets typographiques → suppression
      .replace(/[\u00ab\u00bb\u201c\u201d\u201e\u201f]/g, '')
      // Ellipsis → points
      .replace(/\u2026/g, '...')
      // Unifier "&" et "and"/"et" comme séparateur de collaboration équivalent
      // ex: "Belle & Sebastian" et "Belle and Sebastian" doivent normaliser pareil
      .replace(/\s*&\s*/g, ' and ')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // diacritiques
      // Supprimer les apostrophes et guillemets (pas d'espace, just remove)
       .replace(/[''"`""\u201C\u201D]/g, '')
      // Supprimer annotations entre parenthèses/crochets très courantes
      // ex: "(feat. X)", "[live]", "(radio edit)", "(remaster)", "(bonus track)"
      .replace(/\s*[\(\[](feat\.?|ft\.?|featuring|live|radio\s*edit|single\s*edit|remaster(?:ed)?|bonus\s*track|demo|instrumental|acoustic|extended|album\s*version|original\s*mix)[^\)\]]*[\)\]]/gi, '')
      // Supprimer "feat. X" sans parenthèses en fin de titre
      .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '')
      // Supprimer les annotations entre parenthèses/crochets en fin si elles contiennent des chiffres d'années
      .replace(/\s*[\(\[]\d{4}[\)\]]/g, '')
      // Tout caractère non alphanumérique → espace
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };
  return norm(artist) + '|||' + norm(album);
}

// Retourne plusieurs variantes normalisées pour un artiste :
// - brut, nettoyé Discogs, sans The/A, artiste principal (avant feat/with/&/;)
// Utilisé pour élargir les comparaisons artist→artist
function artistVariants(artist) {
  const v = new Set();
  if (!artist) return v;
  const addNorm = s => { if (s && s.trim()) v.add(normalizeKey(s.trim(), '').replace('|||', '')); };
  addNorm(artist);
  // Discogs "(N)" et virgule inversion
  const clean = cleanDiscogsArtist(artist);
  addNorm(clean);
  // Sans "The " / "A " en tête
  addNorm(clean.replace(/^The\s+/i, '').replace(/^A\s+/i, ''));
  // Artiste principal : couper au premier séparateur de collaboration clair
  // "Asian Dub Foundation feat. Sinéad O'Connor" → "Asian Dub Foundation"
  // "Ben Harper and The Blind Boys of Alabama"   → "Ben Harper"   (and The)
  // "Beethoven; Eugen Duvier"                    → "Beethoven"
  // "Lonnie Johnson with Victoria Spivey"        → "Lonnie Johnson"
  // "Kevin Ayers & The Whole World"              → "Kevin Ayers"
  // "Molina & Johnson"                           → "Molina"
  // "Jeff Buckley & Gary Lucas"                  → "Jeff Buckley"
  // PAS "Diving With Andy" → "Diving"  (trop court, nom propre seul)
  // PAS "Antony and the Johnsons" → "Antony"  (le groupe s'appelle vraiment comme ça)
  const primaryMatch = clean.match(
    /^(.+?)\s*(?:feat\.?|ft\.?|featuring|\bwith\b\s+[A-Z]|&\s+(?:The\b|[A-Z][a-z])|;\s*[A-Z]|,\s*[A-Z][a-z])/
  );
  if (primaryMatch && primaryMatch[1].trim().split(/\s+/).length >= 2) {
    addNorm(primaryMatch[1]);
  }
  // "Various Artists" / "Various" → unifier sous les deux formes
  const n = normalizeKey(clean, '').replace('|||', '');
  if (n === 'various artists' || n === 'various') {
    v.add('various artists');
    v.add('various');
  }
  return v;
}

// Version "souple" : tente plusieurs variantes de normalisation pour matcher
// Retourne true si au moins une variante de keyA correspond à une variante de keyB
// Applique les plays lastfm aux albums via une Map (O(n+m)) au lieu de albums.find() en boucle (O(n*m))
// qui provoquait un "Script terminated by timeout" avec de gros volumes de données.
function applyLastfmPlaysToAlbums(data) {
  const idx = new Map(albums.map(x => [normalizeKey(x.artist, x.album), x]));
  data.forEach(d => {
    const a = idx.get(normalizeKey(d.artist, d.album));
    if (a) a.plays = d.plays;
  });
}

function normalizeKeyLoose(artist, title) {
  const base = normalizeKey(artist, title);
  const variants = new Set([base]);
  // Variante sans numéro de piste en début : "01 something" → "something"
  const withoutTrackNum = normalizeKey('', title.replace(/^\d+[\s.\-_]+/, '')).replace('|||', '');
  if (withoutTrackNum) variants.add(normalizeKey(artist, '').replace('|||', '') + '|||' + withoutTrackNum);
  return variants;
}

function slugEmoji(artist) {
  const map = { jazz:'🎷', rock:'🎸', pop:'🎤', électro:'🤖', electro:'🤖', 'trip-hop':'🌫️', classique:'🎻', métal:'🤘', metal:'🤘', folk:'🪕', soul:'🎙️', reggae:'🌴', blues:'🎼', funk:'🕺', ambient:'🌊', krautrock:'🔊', 'hip-hop':'🎤', rap:'🎤' };
  const g = (albums.find(a => a.artist.toLowerCase() === artist.toLowerCase())?.genre || '').toLowerCase();
  for (const k in map) if (g.includes(k)) return map[k];
  const initials = artist.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
  return initials || '🎵';
}

function initials(artist) {
  return (artist||'?').split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
}

// Résoudre une URL CAA en blob URL via fetch authentifié
function albumAvatar(album) {
  if (album?.cover_url) {
    const url = album.cover_url;
    const ini = initials(album.artist || '?');
    // Ignorer les URLs coverartarchive (bloquées par les clouds) — afficher initiales
    if (url.includes('coverartarchive.org')) return ini;
    // URLs directes (Discogs i.discogs.com, last.fm, etc.) — charger normalement
    return `<img src="${esc(url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.parentElement.textContent='${ini}'" referrerpolicy="no-referrer">`;
  }
  return initials(album?.artist || '?');
}

// ===================== NAVIGATION =====================
const SECTIONS = ['albums', 'discographie', 'wishlist',
  'all-tracks', 'album-tracks', 'tracks', 'track-wishlist',
  'missing', 'missing-tracks', 'rym', 'covers', 'completeness', 'audit', 'ratesession', 'artistview', 'artistlinks', 'marketvalue', 'loans', 'notestoreport', 'journal', 'insights', 'import',
  'ok-albums', 'forsale', 'stock'];
function nav(id) {
  SECTIONS.forEach(s => {
    document.getElementById('sec-' + s).classList.toggle('active', s === id);
    document.querySelectorAll('.nav-item').forEach(el => {
      if (el.getAttribute('onclick') === `nav('${id}')`) el.classList.add('active');
      else el.classList.remove('active');
    });
  });
  const titles = {
    albums: 'Collection', discographie: 'Discographie', wishlist: 'Wishlist albums',
    'all-tracks': 'Tous les morceaux', 'album-tracks': 'Morceaux des albums',
    tracks: 'Morceaux isolés', 'track-wishlist': 'Wishlist morceaux',
    missing: 'last.fm — Albums', 'missing-tracks': 'last.fm — Morceaux',
    rym: 'RateYourMusic', covers: 'Pochettes',
    completeness: 'Complétude',
    audit: 'Audit collection',
    ratesession: 'Session notation', artistview: 'Vue Artiste', artistlinks: 'Artistes similaires', marketvalue: 'Valeur collection', loans: 'Prêts en cours', notestoreport: 'Notes à reporter', journal: 'Journal des changements', insights: 'Insights', import: 'Import / Export'
  };
  const subs = {
    albums: 'Ma collection complète', discographie: 'CDs Discogs vs fichiers MusicBee',
    wishlist: 'Albums à acquérir',
    'all-tracks': 'Tous les morceaux (albums + isolés)', 'album-tracks': 'Pistes issues des albums MusicBee',
    tracks: 'Fichiers isolés (top titres)', 'track-wishlist': 'Morceaux à acquérir',
    missing: 'Albums écoutés absents de la collection', 'missing-tracks': 'Morceaux écoutés absents',
    rym: 'Croisement collection & ratings',
    covers: 'Galerie & résolution des pochettes',
    completeness: 'Pochette / genre / note / tracklist — repérer les fiches négligées',
    audit: 'Vues globales : scores MB bas, écarts note/RYM, divergences Discogs/MusicBrainz, discographie manquante',
    ratesession: 'Un album ou morceau non noté à la fois, ordre aléatoire (albums possédés jamais écoutés inclus)',
    artistview: 'Discographie MusicBrainz complète — possédés et manquants, notes et écoutes rapatriées',
    artistlinks: 'Crédits MusicBrainz croisés avec ta collection',
    marketvalue: 'Estimation via le marketplace Discogs — indicatif, pas une cote officielle',
    loans: 'CD physiques actuellement prêtés',
    notestoreport: 'À reporter manuellement dans MusicBee / Discogs / RYM',
    journal: 'Ce qui a changé depuis un snapshot — pour vérifier l\u2019effet d\u2019un import',
    insights: 'Genres, décennies, artistes, écoutes',
    import: 'Sources externes & sauvegarde'
  };
  document.getElementById('topbar-title').textContent = titles[id] || id;
  document.getElementById('topbar-sub').textContent = subs[id] || '';
  document.getElementById('global-search').value = '';
  if (id === 'albums') renderAlbums();
  if (id === 'discographie') renderDiscographie();
  if (id === 'tracks') renderTracks();
  if (id === 'missing') renderMissing();
  if (id === 'rym') renderRYM();
  if (id === 'wishlist')      renderWishlist();
  if (id === 'missing-tracks') renderMissingTracks();
  if (id === 'all-tracks')    renderAllTracks();
  if (id === 'album-tracks')  renderAlbumTracks();
  if (id === 'track-wishlist') renderTrackWishlist();
  if (id === 'covers') renderCoversGallery();
  if (id === 'completeness') renderCompleteness();
  if (id === 'audit') renderAudit();
  if (id === 'ratesession') initRatingSession();
  if (id === 'import') { renderAssocReview(); renderMissingIds(); }
  if (id === 'artistview') renderArtistView();
  if (id === 'artistlinks') renderArtistLinks();
  if (id === 'marketvalue') renderMarketValue();
  if (id === 'loans') renderLoans();
  if (id === 'notestoreport') renderNotesToReport();
  if (id === 'journal') renderJournal();
  if (id === 'insights') renderInsights();
}

function onSearch() {
  const active = SECTIONS.find(s => document.getElementById('sec-' + s).classList.contains('active'));
  if (active === 'albums') { currentPage = 1; renderAlbums(); }
  if (active === 'discographie') renderDiscographie();
  if (active === 'tracks') renderTracks();
  if (active === 'missing') renderMissing();
  if (active === 'rym') renderRYM();
  if (active === 'wishlist')      renderWishlist();
  if (active === 'missing-tracks') renderMissingTracks();
  if (active === 'all-tracks')    renderAllTracks();
  if (active === 'album-tracks')  renderAlbumTracks();
  if (active === 'track-wishlist') renderTrackWishlist();
}

// ===================== RECHERCHE GLOBALE UNIFIÉE (v2026.07.09) =====================
// Contrairement à #global-search (filtre la section actuellement affichée, existant),
// cette recherche interroge en une fois albums + morceaux isolés + wishlist (albums et
// morceaux) et présente des résultats groupés cliquables qui ouvrent directement la fiche
// concernée — sans avoir à changer manuellement de section au préalable.
function openGlobalSearchModal() {
  document.getElementById('modal-global-search').classList.add('open');
  const input = document.getElementById('gs-input');
  input.value = '';
  document.getElementById('gs-results').innerHTML = '<div class="empty" style="padding:24px 0"><div class="empty-icon">🔎</div>Tapez pour chercher dans toute la collection.</div>';
  setTimeout(() => input.focus(), 50);
}
function closeGlobalSearchModal() {
  document.getElementById('modal-global-search').classList.remove('open');
}

// Score simple : correspondance exacte > commence par > contient — pour faire remonter
// les résultats les plus pertinents en tête de chaque groupe.
function _gsScore(text, q) {
  const t = (text || '').toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  return 2;
}

const _gsDebounced = debounce(() => _gsRun(), 150);
function performGlobalSearch() { _gsDebounced(); }

function _gsRun() {
  const raw = document.getElementById('gs-input').value.trim();
  const q = raw.toLowerCase();
  const results = document.getElementById('gs-results');
  if (q.length < 2) {
    results.innerHTML = '<div class="empty" style="padding:24px 0"><div class="empty-icon">🔎</div>Continuez à taper (2 caractères min.)…</div>';
    return;
  }

  const albumMatches = albums
    .filter(a => (a.artist + ' ' + a.album).toLowerCase().includes(q))
    .sort((a, b) => _gsScore(a.artist + ' ' + a.album, q) - _gsScore(b.artist + ' ' + b.album, q))
    .slice(0, 8);

  const trackMatches = tracks
    .filter(t => (t.artist + ' ' + t.title).toLowerCase().includes(q))
    .sort((a, b) => _gsScore(a.artist + ' ' + a.title, q) - _gsScore(b.artist + ' ' + b.title, q))
    .slice(0, 8);

  const wishAlbumMatches = wishlist
    .filter(w => (w.artist + ' ' + w.album).toLowerCase().includes(q))
    .sort((a, b) => _gsScore(a.artist + ' ' + a.album, q) - _gsScore(b.artist + ' ' + b.album, q))
    .slice(0, 6);

  const wishTrackMatches = trackWishlist
    .filter(w => (w.artist + ' ' + w.title).toLowerCase().includes(q))
    .sort((a, b) => _gsScore(a.artist + ' ' + a.title, q) - _gsScore(b.artist + ' ' + b.title, q))
    .slice(0, 6);

  const total = albumMatches.length + trackMatches.length + wishAlbumMatches.length + wishTrackMatches.length;
  if (!total) {
    results.innerHTML = '<div class="empty" style="padding:24px 0"><div class="empty-icon">🕳️</div>Aucun résultat pour « ' + esc(raw) + ' ».</div>';
    return;
  }

  const folderBadge = a => {
    const f = a.folders || [];
    if (f.includes('stock')) return '📦 Stock';
    if (f.includes('forsale')) return '💸 À vendre';
    if (f.includes('ok')) return '✅ Ok';
    if (a.has_cd || a.cd) return '💿 CD';
    return '💾 Numérique';
  };

  const section = (title, icon, rows) => !rows.length ? '' : `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text3);margin:6px 0 4px;font-family:var(--mono)">${icon} ${esc(title)} (${rows.length})</div>
      ${rows.join('')}
    </div>`;

  const gsRow = (title, sub, badge, onclick) => `
    <div class="gs-row" onclick="${onclick}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='transparent'">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>
        <div style="font-size:12px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>
      </div>
      ${badge ? `<span style="font-size:11px;color:var(--text3);flex-shrink:0">${badge}</span>` : ''}
    </div>`;

  results.innerHTML =
    section('Albums', '💽', albumMatches.map(a =>
      gsRow(esc(a.album), esc(a.artist) + (a.year ? ' · ' + a.year : ''), folderBadge(a), `jumpToGlobalSearchAlbum('${a.id}')`)
    )) +
    section('Morceaux isolés', '🎵', trackMatches.map(t =>
      gsRow(esc(t.title), esc(t.artist) + (t.album ? ' · ' + esc(t.album) : ''), (t.note ? '★'.repeat(t.note) : ''), `jumpToGlobalSearchTrack(${t.id})`)
    )) +
    section('Wishlist — albums', '🎯', wishAlbumMatches.map(w =>
      gsRow(esc(w.album), esc(w.artist) + (w.year ? ' · ' + w.year : ''), ({high:'🔴',mid:'🟡',low:'🟢'})[w.prio] || '', `jumpToGlobalSearchWishAlbum(${w.id})`)
    )) +
    section('Wishlist — morceaux', '🎯', wishTrackMatches.map(w =>
      gsRow(esc(w.title), esc(w.artist), ({high:'🔴',mid:'🟡',low:'🟢'})[w.prio] || '', `jumpToGlobalSearchWishTrack(${w.id})`)
    ));
}

function jumpToGlobalSearchAlbum(id) {
  closeGlobalSearchModal();
  const a = albums.find(x => x.id === id || x.id === String(id));
  if (!a) return;
  nav('albums');
  document.getElementById('global-search').value = a.artist + ' ' + a.album;
  renderAlbums();
  editAlbum(sid(a.id));
}
function jumpToGlobalSearchTrack(id) {
  closeGlobalSearchModal();
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  nav('tracks');
  document.getElementById('global-search').value = t.artist + ' ' + t.title;
  renderTracks();
}
function jumpToGlobalSearchWishAlbum(id) {
  closeGlobalSearchModal();
  nav('wishlist');
  document.getElementById('global-search').value = '';
  renderWishlist();
  openWishModal(id);
}
function jumpToGlobalSearchWishTrack(id) {
  closeGlobalSearchModal();
  nav('track-wishlist');
  document.getElementById('global-search').value = '';
  renderTrackWishlist();
  openTrackWishModal(id);
}

// Raccourci clavier Ctrl+K / Cmd+K — ouvre la recherche globale depuis n'importe où
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openGlobalSearchModal();
  } else if (e.key === 'Escape' && document.getElementById('modal-global-search')?.classList.contains('open')) {
    closeGlobalSearchModal();
  }
});

// ===================== ALBUMS =====================

// Cache des clés stock pour exclusion rapide
function getStockKeysSet() {
  if (_cache.stockKeysSet) return _cache.stockKeysSet;
  _cache.stockKeysSet = new Set(stockItems.map(s => normalizeKey(s.artist, s.album)));
  return _cache.stockKeysSet;
}

// Index RYM (artiste, album) → entrée rymData
// Deux index séparés :
// - exact : clé normalizeKey(artist,album) stricte, jamais ambiguë, toujours prioritaire
// - fuzzy : variantes d'artiste (&, The, Discogs clean...) en filet de sécurité SEULEMENT
//   si rien n'est trouvé en exact. Le filet de sécurité ne doit jamais écraser une
//   correspondance exacte différente — sinon deux artistes distincts partageant une
//   variante courte (ex: "Various"/"Various Artists", ou un nom tronqué par feat./with)
//   finissent par se voler mutuellement leur note RYM.
function getRymIndex() {
  if (_cache.rymIndex) return _cache.rymIndex;
  const exact = new Map();
  const fuzzy = new Map();
  rymData.forEach(r => {
    const exactKey = normalizeKey(r.artist, r.album);
    // En cas de doublon exact dans rymData, garder l'entrée notée si possible
    const prevExact = exact.get(exactKey);
    if (!prevExact || (!prevExact.rating && r.rating)) exact.set(exactKey, r);

    const albumNorm = normalizeKey('', r.album).replace('|||', '');
    for (const av of artistVariants(r.artist)) {
      const k = av + '|||' + albumNorm;
      if (k === exactKey) continue; // déjà couvert par l'index exact
      // Marquer comme ambiguë si une autre entrée RYM différente revendique déjà cette variante
      if (fuzzy.has(k) && fuzzy.get(k) !== '__ambiguous__' && fuzzy.get(k).artist !== r.artist) {
        fuzzy.set(k, '__ambiguous__');
      } else if (!fuzzy.has(k)) {
        fuzzy.set(k, r);
      }
    }
  });
  _cache.rymIndex = { exact, fuzzy };
  return _cache.rymIndex;
}

// Recherche RYM tolérante : clé exacte d'abord (fiable), variante ensuite
// (ignorée si ambiguë, c.à.d. partagée par plusieurs artistes différents).
function lookupRym(artist, album, albumId) {
  const { exact, fuzzy } = getRymIndex();
  const exactHit = exact.get(normalizeKey(artist, album));
  if (exactHit) return exactHit;
  const albumNorm = normalizeKey('', album).replace('|||', '');
  for (const av of artistVariants(artist)) {
    const hit = fuzzy.get(av + '|||' + albumNorm);
    if (hit && hit !== '__ambiguous__') return hit;
  }
  // Fallback : association manuelle via rymAssociations
  if (albumId) {
    const assoc = rymAssociations.find(a => a.albumKey === albumId);
    if (assoc) return rymData.find(r => normalizeKey(r.artist, r.album) === assoc.rymKey);
  }
  return undefined;
}

// Variante de lookupRym qui expose aussi COMMENT la correspondance a été trouvée
// (exact / variante d'artiste / association manuelle) — utilisée pour le score de confiance
// visible dans le détail album, pour distinguer une note fiable d'une note à revalider.
function lookupRymWithMeta(artist, album, albumId) {
  const { exact, fuzzy } = getRymIndex();
  const exactHit = exact.get(normalizeKey(artist, album));
  if (exactHit) return { entry: exactHit, matchType: 'exact' };
  const albumNorm = normalizeKey('', album).replace('|||', '');
  for (const av of artistVariants(artist)) {
    const hit = fuzzy.get(av + '|||' + albumNorm);
    if (hit && hit !== '__ambiguous__') return { entry: hit, matchType: 'fuzzy' };
  }
  if (albumId) {
    const assoc = rymAssociations.find(a => a.albumKey === albumId);
    if (assoc) {
      const entry = rymData.find(r => normalizeKey(r.artist, r.album) === assoc.rymKey);
      if (entry) return { entry, matchType: 'manual' };
    }
  }
  return { entry: undefined, matchType: null };
}

// Évalue un filtre note inline [op, val] contre une valeur réelle
// op: 'gte'|'gt'|'eq'|'lte'|'none'|'any'|''
function matchNoteFilter(op, valStr, actual) {
  if (!op) return true;
  const v = parseFloat(valStr);
  if (op === 'none') return !actual || actual === 0;
  if (op === 'any')  return !!(actual && actual > 0);
  if (isNaN(v)) return true; // valeur pas encore saisie → pas de filtre
  if (op === 'gte') return (actual || 0) >= v;
  if (op === 'gt')  return (actual || 0) >  v;
  if (op === 'eq')  return Math.abs((actual || 0) - v) < 0.01;
  if (op === 'lte') return (actual || 0) <= v && (actual || 0) > 0;
  return true;
}

// Affiche/masque le champ valeur selon l'opérateur sélectionné
function onNoteOpChange(opId, valId) {
  const op  = document.getElementById(opId)?.value  || '';
  const inp = document.getElementById(valId);
  if (!inp) return;
  inp.style.display = (op && op !== 'none' && op !== 'any') ? '' : 'none';
}

// ===================== FILTRES SAUVEGARDÉS (multi-vues) =====================
// Préréglages nommés pour les barres de filtres — évite de recomposer à chaque fois
// les mêmes combinaisons (genre + note + dossier + tri, etc.). Stockés en localStorage
// (état d'affichage local, pas une donnée de collection à synchroniser via Supabase).
// v2026.07.09-04 : Collection uniquement. v2026.07.09-05 : généralisé à Discographie,
// Stock et Wishlist — même mécanique, config par vue (champs, select de préréglage,
// fonction de rendu à rappeler après application).
const FILTER_PRESETS_LS_KEY = 'terant_filter_presets_v2';
const FILTER_PRESETS_LS_KEY_LEGACY_COLLECTION = 'terant_filter_presets_collection_v1';

const FILTER_PRESET_VIEWS = {
  collection: {
    selectId: 'filter-preset-select',
    resetPage: true,
    renderFn: () => renderAlbums(),
    fields: ['filter-artist', 'filter-album', 'filter-support', 'filter-folder', 'filter-genre', 'filter-wishlist',
      'filter-note-op', 'filter-note-val', 'filter-dc-note-op', 'filter-dc-note-val',
      'filter-rym-note-op', 'filter-rym-note-val', 'filter-year', 'filter-min-plays', 'sort-col'],
    noteOpPairs: [['filter-note-op', 'filter-note-val'], ['filter-dc-note-op', 'filter-dc-note-val'], ['filter-rym-note-op', 'filter-rym-note-val']]
  },
  discographie: {
    selectId: 'filter-preset-select-disco',
    resetPage: false,
    renderFn: () => renderDiscographie(),
    fields: ['disco-filter', 'disco-filter-type', 'filter-disco-artist', 'filter-disco-album', 'filter-disco-year',
      'filter-disco-genre', 'filter-disco-note-op', 'filter-disco-note-val', 'filter-disco-dc-op', 'filter-disco-dc-val',
      'filter-disco-rym-op', 'filter-disco-rym-val', 'filter-disco-min-plays', 'disco-sort'],
    noteOpPairs: [['filter-disco-note-op', 'filter-disco-note-val'], ['filter-disco-dc-op', 'filter-disco-dc-val'], ['filter-disco-rym-op', 'filter-disco-rym-val']]
  },
  stock: {
    selectId: 'filter-preset-select-stock',
    resetPage: false,
    renderFn: () => renderStock(),
    fields: ['filter-stock-artist', 'filter-stock-genre', 'filter-stock-year', 'filter-stock-note-op', 'filter-stock-note-val'],
    noteOpPairs: [['filter-stock-note-op', 'filter-stock-note-val']]
  },
  wishlist: {
    selectId: 'filter-preset-select-wish',
    resetPage: false,
    renderFn: () => renderWishlist(),
    fields: ['filter-wish-artist', 'filter-wish-album', 'filter-wish-source', 'filter-wish-year', 'filter-wish-prio'],
    noteOpPairs: []
  },
  rym: {
    selectId: 'filter-preset-select-rym',
    resetPage: false,
    renderFn: () => renderRYM(),
    fields: ['filter-rym-artist', 'filter-rym-album', 'filter-rym-genre', 'filter-rym-year', 'rym-threshold'],
    noteOpPairs: []
  }
};

function loadAllFilterPresets() {
  try {
    const raw = localStorage.getItem(FILTER_PRESETS_LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    }
    // Migration ponctuelle depuis l'ancien stockage mono-vue (Collection uniquement, v04)
    const legacy = localStorage.getItem(FILTER_PRESETS_LS_KEY_LEGACY_COLLECTION);
    if (legacy) {
      const arr = JSON.parse(legacy);
      const migrated = { collection: Array.isArray(arr) ? arr : [] };
      localStorage.setItem(FILTER_PRESETS_LS_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (e) {}
  return {};
}

function loadFilterPresets(viewKey) {
  const all = loadAllFilterPresets();
  return Array.isArray(all[viewKey]) ? all[viewKey] : [];
}

function saveFilterPresetsToStorage(viewKey, list) {
  try {
    const all = loadAllFilterPresets();
    all[viewKey] = list;
    localStorage.setItem(FILTER_PRESETS_LS_KEY, JSON.stringify(all));
  } catch (e) { toast('Impossible d\'enregistrer le préréglage (stockage local plein ?)', 'error'); }
}

function captureCurrentFilterValues(viewKey) {
  const values = {};
  (FILTER_PRESET_VIEWS[viewKey]?.fields || []).forEach(id => {
    const el = document.getElementById(id);
    if (el) values[id] = el.value;
  });
  return values;
}

function isFilterValuesEmpty(values) {
  return Object.values(values || {}).every(v => !v);
}

function renderFilterPresetOptions(viewKey) {
  const cfg = FILTER_PRESET_VIEWS[viewKey];
  if (!cfg) return;
  const sel = document.getElementById(cfg.selectId);
  if (!sel) return;
  const keepSelected = sel.value;
  const presets = loadFilterPresets(viewKey);
  sel.innerHTML = '<option value="">💾 Filtres…</option>' +
    presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (presets.some(p => p.id === keepSelected)) sel.value = keepSelected;
}

function renderAllFilterPresetOptions() {
  Object.keys(FILTER_PRESET_VIEWS).forEach(renderFilterPresetOptions);
}

function saveCurrentFilterPreset(viewKey) {
  const cfg = FILTER_PRESET_VIEWS[viewKey];
  if (!cfg) return;
  const values = captureCurrentFilterValues(viewKey);
  if (isFilterValuesEmpty(values)) {
    toast('Aucun filtre actif à enregistrer', 'error');
    return;
  }
  const name = (prompt('Nom du préréglage de filtres :') || '').trim();
  if (!name) return;
  const presets = loadFilterPresets(viewKey);
  const existing = presets.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!confirm(`Un préréglage "${existing.name}" existe déjà — le remplacer ?`)) return;
    existing.values = values;
    existing.updatedAt = new Date().toISOString();
    saveFilterPresetsToStorage(viewKey, presets);
    renderFilterPresetOptions(viewKey);
    document.getElementById(cfg.selectId).value = existing.id;
    toast(`Préréglage "${existing.name}" mis à jour ✓`);
    return;
  }
  const preset = { id: 'fp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, values, createdAt: new Date().toISOString() };
  presets.push(preset);
  saveFilterPresetsToStorage(viewKey, presets);
  renderFilterPresetOptions(viewKey);
  document.getElementById(cfg.selectId).value = preset.id;
  toast(`Préréglage "${name}" enregistré ✓`);
}

function applyFilterPreset(viewKey) {
  const cfg = FILTER_PRESET_VIEWS[viewKey];
  if (!cfg) return;
  const sel = document.getElementById(cfg.selectId);
  const id = sel?.value || '';
  if (!id) return;
  const preset = loadFilterPresets(viewKey).find(p => p.id === id);
  if (!preset) return;
  cfg.fields.forEach(fieldId => {
    const el = document.getElementById(fieldId);
    if (el && fieldId in preset.values) el.value = preset.values[fieldId];
  });
  cfg.noteOpPairs.forEach(([opId, valId]) => onNoteOpChange(opId, valId));
  if (cfg.resetPage) currentPage = 1;
  cfg.renderFn();
  toast(`Préréglage "${preset.name}" appliqué`);
}

function deleteSelectedFilterPreset(viewKey) {
  const cfg = FILTER_PRESET_VIEWS[viewKey];
  if (!cfg) return;
  const sel = document.getElementById(cfg.selectId);
  const id = sel?.value || '';
  if (!id) { toast('Choisissez d\'abord un préréglage à supprimer', 'error'); return; }
  const presets = loadFilterPresets(viewKey);
  const preset = presets.find(p => p.id === id);
  if (!preset) return;
  if (!confirm(`Supprimer le préréglage "${preset.name}" ?`)) return;
  saveFilterPresetsToStorage(viewKey, presets.filter(p => p.id !== id));
  renderFilterPresetOptions(viewKey);
  toast(`Préréglage "${preset.name}" supprimé ✓`);
}

function filteredAlbums() {
  const q = document.getElementById('global-search').value.toLowerCase();
  const af = (document.getElementById('filter-artist').value || '').toLowerCase().trim();
  const albf = (document.getElementById('filter-album').value || '').toLowerCase().trim();
  const sf = document.getElementById('filter-support').value;
  const ff = document.getElementById('filter-folder')?.value || '';
  const gf = document.getElementById('filter-genre').value;
  const nfOp = document.getElementById('filter-note-op')?.value || '';
  const nfVal = document.getElementById('filter-note-val')?.value || '';
  const dcNfOp = document.getElementById('filter-dc-note-op')?.value || '';
  const dcNfVal = document.getElementById('filter-dc-note-val')?.value || '';
  const rymNfOp = document.getElementById('filter-rym-note-op')?.value || '';
  const rymNfVal = document.getElementById('filter-rym-note-val')?.value || '';
  const minPlays = parseInt(document.getElementById('filter-min-plays')?.value || '0') || 0;
  const yearF = (document.getElementById('filter-year')?.value || '').trim();
  const wf = document.getElementById('filter-wishlist')?.value || '';
  // Correspondance EXACTE (même logique que pruneWishlistOwned/wishlistOwnedSet) — construite
  // une seule fois ici plutôt que dans le .filter() ci-dessous pour éviter de reconstruire le
  // Set à chaque album passé en revue.
  const wishKeys = wf ? new Set(wishlist.map(w => normalizeKey(w.artist, w.album))) : null;

  return albums.filter(a => {
    // ── Filtre dossier ───────────────────────────────────────────────────
    if (ff === 'stock')       { if (!a.folders?.includes('stock'))   return false; }
    else if (ff === 'ok')     { if (!a.okFolder)                      return false; }
    else if (ff === 'forsale'){ if (!a.forSale)                       return false; }
    else if (ff === 'discographie') {
      if (!(a.primaryFolder === 'discographie' || a.folders?.includes('discographie'))) return false;
    }
    // Sans filtre dossier : tout afficher (stock inclus, badge 📦 s'affichera)

    // ── Filtre support ───────────────────────────────────────────────────
    if (sf === 'cd')      { if (!a.cd)                          return false; }
    else if (sf === 'flac')   { if (!a.flac)                         return false; }
    else if (sf === 'mp3')    { if (!a.mp3)                          return false; }
    else if (sf === 'digital'){ if (!(a.flac || a.mp3 || a.digital)) return false; }

    // ── Filtres texte ────────────────────────────────────────────────────
    if (q   && !(a.artist + ' ' + a.album + ' ' + (a.genre||'')).toLowerCase().includes(q)) return false;
    if (af  && !a.artist.toLowerCase().includes(af))  return false;
    if (albf&& !a.album.toLowerCase().includes(albf)) return false;
    if (gf  && a.genre !== gf) return false;
    if (yearF && !(a.year||'').startsWith(yearF)) return false;

    // ── Filtre note MusicBee ─────────────────────────────────────────────
    if (!matchNoteFilter(nfOp, nfVal, a.note || 0)) return false;

    // ── Filtre note Discogs ──────────────────────────────────────────────
    if (!matchNoteFilter(dcNfOp, dcNfVal, a.discogsRating || 0)) return false;

    // ── Filtre note RYM ──────────────────────────────────────────────────
    if (rymNfOp) {
      const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
      if (!matchNoteFilter(rymNfOp, rymNfVal, rymEntry?.rating || 0)) return false;
    }

    // ── Filtre écoutes min ───────────────────────────────────────────────
    if ((a.plays || 0) < minPlays) return false;

    // ── Filtre wishlist ───────────────────────────────────────────────────
    // Utile notamment pour repérer les albums encore listés en wishlist alors qu'ils sont
    // déjà en collection numérique/Stock — cf. wishlistOwnedSet() : seul Discogs auto-retire
    // de la wishlist, un album seulement en Stock peut donc légitimement rester en wishlist.
    if (wf === 'yes' && !wishKeys.has(normalizeKey(a.artist, a.album))) return false;
    if (wf === 'no'  &&  wishKeys.has(normalizeKey(a.artist, a.album))) return false;

    return true;
  });
}

function sortedAlbums(list) {
  const col = document.getElementById('sort-col').value;
  if (col === 'rym') {
    return [...list].sort((a, b) => {
      const ra = (lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id))?.rating || 0;
      const rb = (lookupRym(b.artist, b.album, b.id) || lookupRym(cleanDiscogsArtist(b.artist), b.album, b.id))?.rating || 0;
      return rb - ra;
    });
  }
  if (col === 'dc') {
    return [...list].sort((a, b) => (b.discogsRating||0) - (a.discogsRating||0));
  }
  return [...list].sort((a, b) => {
    if (col === 'year') return (b.year||0) - (a.year||0);
    if (col === 'note') return (b.note||0) - (a.note||0);
    if (col === 'plays') return (b.plays||0) - (a.plays||0);
    const av = (a[col]||'').toLowerCase(), bv = (b[col]||'').toLowerCase();
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

// ===================== SÉLECTION MULTIPLE / ACTIONS GROUPÉES (Collection) =====================
// Set d'ids réels (pas sid()) — persiste volontairement entre les pages pour permettre une
// sélection à cheval sur plusieurs pages de résultats filtrés.
let selectedAlbumIds = new Set();

function toggleAlbumSelected(idSid, checked) {
  const id = unsid(idSid);
  const a = albums.find(x => x.id === id || x.id === String(id));
  const realId = a ? a.id : id;
  if (checked) selectedAlbumIds.add(realId); else selectedAlbumIds.delete(realId);
  renderBulkActionsBar();
}

// idem, mais pour le tableau Discographie — même Set, même logique de résolution d'id
function toggleSelectAllDisco(checked) {
  document.querySelectorAll('#disco-tbody .row-select').forEach(cb => {
    cb.checked = checked;
    const id = unsid(cb.dataset.id);
    const a = albums.find(x => x.id === id || x.id === String(id));
    const realId = a ? a.id : id;
    if (checked) selectedAlbumIds.add(realId); else selectedAlbumIds.delete(realId);
  });
  renderBulkActionsBar();
}

function toggleSelectAllAlbums(checked) {
  document.querySelectorAll('#album-tbody .row-select').forEach(cb => {
    cb.checked = checked;
    const id = unsid(cb.dataset.id);
    const a = albums.find(x => x.id === id || x.id === String(id));
    const realId = a ? a.id : id;
    if (checked) selectedAlbumIds.add(realId); else selectedAlbumIds.delete(realId);
  });
  renderBulkActionsBar();
}

// Sélection partagée entre Collection et Discographie (mêmes fiches album) : on efface
// les cases à cocher des deux tableaux, qu'ils soient actuellement affichés ou non.
function clearAlbumSelection() {
  selectedAlbumIds.clear();
  document.querySelectorAll('#album-tbody .row-select, #disco-tbody .row-select').forEach(cb => { cb.checked = false; });
  const selAllCb = document.getElementById('select-all-albums');
  if (selAllCb) selAllCb.checked = false;
  const selAllDiscoCb = document.getElementById('select-all-disco');
  if (selAllDiscoCb) selAllDiscoCb.checked = false;
  renderBulkActionsBar();
}

function renderBulkActionsBar() {
  const n = selectedAlbumIds.size;
  const label = n ? `${n} album${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}` : '';
  [['bulk-actions-bar', 'bulk-actions-count'], ['bulk-actions-bar-disco', 'bulk-actions-count-disco']].forEach(([barId, countId]) => {
    const bar = document.getElementById(barId);
    if (!bar) return;
    const countEl = document.getElementById(countId);
    if (countEl) countEl.textContent = label;
    bar.style.display = n ? 'flex' : 'none';
  });
}

function bulkAddToWishlist() {
  if (!selectedAlbumIds.size) return;
  let added = 0, skipped = 0;
  selectedAlbumIds.forEach(id => {
    const a = albums.find(x => x.id === id || x.id === String(id));
    if (!a) return;
    const key = normalizeKey(a.artist, a.album);
    if (wishlist.find(w => normalizeKey(w.artist, w.album) === key)) { skipped++; return; }
    let prio = 'low';
    if ((a.plays || 0) >= 50) prio = 'high'; else if ((a.plays || 0) >= 10) prio = 'mid';
    wishlist.push({ id: uid(), artist: a.artist, album: a.album, year: a.year || '', source: 'manual',
      prio, plays: a.plays || 0, rymRating: 0, notes: '', addedAt: Date.now() });
    added++;
  });
  updateNavBadges();
  saveToStorage();
  renderAlbums();
  renderDiscographie();
  clearAlbumSelection();
  toast(`${added} album(s) ajouté(s) à la wishlist${skipped ? ` — ${skipped} déjà présent(s)` : ''}`);
}

function bulkMarkForSale() {
  if (!selectedAlbumIds.size) return;
  if (!confirm(`Marquer ${selectedAlbumIds.size} album(s) comme "à vendre" ?`)) return;
  let n = 0;
  selectedAlbumIds.forEach(id => {
    const a = albums.find(x => x.id === id || x.id === String(id));
    if (!a) return;
    a.forSale = true;
    if (!a.folders) a.folders = [];
    if (!a.folders.includes('forsale')) a.folders.push('forsale');
    n++;
  });
  invalidateCache();
  saveToStorage();
  renderDiscographie();
  renderForSale();
  renderAlbums();
  updateNavBadges();
  clearAlbumSelection();
  toast(`${n} album(s) marqué(s) à vendre`);
}

function bulkUnmarkOk() {
  if (!selectedAlbumIds.size) return;
  let n = 0;
  selectedAlbumIds.forEach(id => {
    const a = albums.find(x => x.id === id || x.id === String(id));
    if (!a || !a.okFolder) return;
    a.okFolder = false;
    if (a.folders) a.folders = a.folders.filter(f => f !== 'ok');
    n++;
  });
  if (!n) { toast('Aucun album sélectionné n\u2019est dans Ok', 'warn'); return; }
  invalidateCache();
  saveToStorage();
  renderOkAlbums();
  renderAlbums();
  renderDiscographie();
  updateNavBadges();
  clearAlbumSelection();
  toast(`${n} album(s) retiré(s) de Ok`);
}

// bulkDeleteAlbums supprimée (v2026.07.10-03) — idem, plus aucun bouton n'y mène.

function renderAlbums() {
  updateStats();
  updateGenreFilter();
  updateArtistFilter();

  const list = sortedAlbums(filteredAlbums());
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > pages) currentPage = pages;
  const slice = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const maxPlays = Math.max(1, ...albums.map(a => a.plays || 0));

  // Index RYM (lookup via lookupRym, prend en compte exact + fuzzy)
  // (variable conservée pour compat lecture, plus utilisée directement ci-dessous)

  const ctr = document.getElementById('albums-counter');
  if (ctr) ctr.textContent = total.toLocaleString('fr-FR') + ' / ' + albums.filter(a => !getStockKeysSet().has(normalizeKey(a.artist, a.album))).length.toLocaleString('fr-FR') + ' albums';

  const stockKeys = getStockKeysSet();
  const tbody = document.getElementById('album-tbody');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-icon">📀</div>Aucun album trouvé</div></td></tr>';
    document.getElementById('page-info').textContent = '';
    renderBulkActionsBar();
    return;
  }

  const ff = document.getElementById('filter-folder')?.value || '';
  // Clés wishlist albums (une seule fois pour tout le rendu) — pour signaler directement dans
  // la Collection qu'un album déjà possédé (ex: numérique) est aussi en wishlist (ex: pour en
  // acquérir le CD), ce qui n'était visible nulle part avant.
  const wishlistKeys = new Set(wishlist.map(w => normalizeKey(w.artist, w.album)));
  tbody.innerHTML = slice.map(a => {
    const isStock   = a.folders?.includes('stock')   || a.primaryFolder === 'stock';
    const isOk      = !!a.okFolder;
    const isForSale = !!a.forSale;
    const isWishlisted = wishlistKeys.has(normalizeKey(a.artist, a.album));

    const badges = [
      a.cd      ? '<span class="badge badge-cd">💿 CD</span>' : '',
      a.flac    ? '<span class="badge badge-flac">FLAC</span>' : '',
      a.mp3     ? '<span class="badge badge-mp3">MP3</span>' : '',
      a.digital ? '<span class="badge badge-digital">Digital</span>' : '',
      isStock   ? '<span class="badge badge-stock">📦 Stock</span>' : '',
      isOk      ? '<span class="badge badge-stock" style="background:rgba(100,220,100,0.08);color:#6ddc6d;border-color:rgba(100,220,100,0.25)">✅ Ok</span>' : '',
      isForSale ? '<span class="badge badge-stock" style="background:rgba(255,192,0,0.08);color:var(--amber);border-color:rgba(255,192,0,0.25)">💸 Vendre</span>' : '',
      isWishlisted ? '<span class="badge badge-stock" title="Dans la wishlist albums" style="background:rgba(255,105,180,0.08);color:#ff8ecb;border-color:rgba(255,105,180,0.25)">🎯 Wishlist</span>' : '',
    ].filter(Boolean).join('');

    const noteCell = `<span onclick="event.stopPropagation();promptStockRating('${sid(a.id)}')" title="Modifier la note MusicBee" style="cursor:pointer;display:inline-flex;align-items:center">
        ${a.note ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${a.note.toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`}
      </span>`;
    const playsW = Math.round((a.plays || 0) / maxPlays * 100);

    // Note RYM
    const rymEntry = lookupRym(a.artist, a.album) || lookupRym(cleanDiscogsArtist(a.artist), a.album)
      || (() => { const assoc = rymAssociations.find(x => x.albumKey === a.id); return assoc ? rymData.find(r => normalizeKey(r.artist, r.album) === assoc.rymKey) : null; })();
    const hasManualAssoc = rymAssociations.some(x => x.albumKey === a.id);
    const rymHtml = `<span onclick="event.stopPropagation();openRYMAssocFromCollection('${sid(a.id)}')" title="Associer/modifier la note RYM" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px">
        ${rymEntry?.rating
          ? `<span style="font-family:var(--mono);font-size:12px;color:var(--amber)">${rymEntry.rating.toFixed(2)}<span style="font-size:10px;opacity:0.7">★</span></span>${hasManualAssoc ? '<span style="font-size:9px;color:var(--accent)" title="Association manuelle">🔗</span>' : ''}`
          : `<span style="color:var(--text3);font-size:12px;opacity:0.35" title="Pas de note RYM">⭐</span>`}
      </span>`;

    const onclickRow = isStock ? `openStockModal('${sid(a.id)}')` : `editAlbum('${sid(a.id)}')`;

    // Bouton d'action contextuel selon le dossier filtré
    // Suppression album/stock retirée : le principe de l'app est que les ajouts/
    // suppressions passent uniquement par les imports MusicBee/Discogs.
    let actionBtn = '';
    if (ff === 'ok' && isOk) {
      actionBtn = `<button class="btn btn-sm" onclick="markOkDone('${sid(a.id)}');event.stopPropagation()" title="Retirer de Ok">✕ Ok</button>`;
    } else if (ff === 'forsale' && isForSale) {
      actionBtn = `<button class="btn btn-sm" onclick="unmarkForSale('${sid(a.id)}');event.stopPropagation()" title="Vendu">✓</button>`;
    }

    // Wishlist — uniquement pour les albums en stock ou dans Ok/
    const wishBtn = (isStock || isOk)
      ? `<button class="btn btn-sm" onclick="addToWishlistFromAlbumId('${sid(a.id)}');event.stopPropagation()" title="Ajouter à la wishlist">🎯</button>`
      : '';

    const ytBtn = `<button class="btn btn-sm" onclick="openYouTubeMusicForAlbumId('${sid(a.id)}');event.stopPropagation()" title="${a.youtube_url ? 'Écouter sur YouTube Music (lien direct MusicBrainz)' : 'Chercher sur YouTube Music'}">▶️</button>`;

    // Fusion manuelle — seulement pour les fiches "normales" (pas stock)
    const mergeBtn = !isStock
      ? `<button class="btn btn-sm" onclick="openMergeAlbumModal('${sid(a.id)}');event.stopPropagation()" title="Fusionner avec une autre fiche (ex: CD + numérique séparés)">🔗</button>`
      : '';

    return `<tr onclick="${onclickRow}" style="cursor:pointer">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="${sid(a.id)}" ${selectedAlbumIds.has(a.id) ? 'checked' : ''} onchange="toggleAlbumSelected('${sid(a.id)}', this.checked)"></td>
      <td>
        <div class="artist-cell">
          <div class="artist-avatar">${albumAvatar(a)}</div>
          <div class="artist-info">
            <div class="name">${esc(a.album)}${mbTypeBadge(a)}</div>
            <div class="sub">${artistLink(a.artist)}${!isStock && a.discogsId ? ` <a href="https://www.discogs.com/release/${a.discogsId}" target="_blank" onclick="event.stopPropagation()" style="font-family:var(--mono);font-size:10px;color:var(--text3);text-decoration:none;margin-left:4px" title="Voir sur Discogs">#${a.discogsId}</a>` : ''}</div>
          </div>
        </div>
      </td>
      <td class="mono">${a.year || '–'}${origYearBadge(a)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(a.genre||'–')}</td>
      <td><div class="badges-cell">${badges || '<span style="color:var(--text3);font-size:11px">–</span>'}</div></td>
        <td>${noteCell}</td>
      <td><span onclick="event.stopPropagation();promptDiscogsRating('${sid(a.id)}')" title="Modifier la note Discogs" style="cursor:pointer;display:inline-flex;align-items:center">
          ${a.discogsRating ? `<span style="font-family:var(--mono);font-size:12px;color:var(--blue)">${Number(a.discogsRating).toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`}
        </span></td>
      <td>${rymHtml}</td>
      <td>
        <div class="plays-bar-wrap">
          <div class="plays-bar"><div class="plays-fill" style="width:${playsW}%"></div></div>
          <span class="plays-num">${a.plays||0}</span>
        </div>
      </td>
      <td onclick="event.stopPropagation()" style="display:flex;gap:4px">${wishBtn}${ytBtn}${mergeBtn}${actionBtn}</td>
    </tr>`;
  }).join('');

  document.getElementById('page-info').textContent = `Page ${currentPage} / ${pages} — ${total} albums`;
  renderBulkActionsBar();
  const selAllCb = document.getElementById('select-all-albums');
  if (selAllCb) selAllCb.checked = slice.length > 0 && slice.every(a => selectedAlbumIds.has(a.id));
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Comme esc() mais échappe aussi les guillemets — pour un usage dans un attribut HTML
// double-quoté (ex: data-title="...") où esc() seul ne suffit pas.
function escAttr(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Badge type de release-group MusicBrainz (todo section 6, item ⬜) : n'affiche rien pour
// le cas courant "Album" sans secondary-types (bruit inutile sur la majorité des lignes),
// seulement quand ça apporte une info (EP/Single/Compilation/Live/...).
const MB_TYPE_LABELS = { EP: 'EP', Single: 'Single', Broadcast: 'Diffusion', Other: 'Autre' };
const MB_SECONDARY_LABELS = { Compilation: 'Compil', Live: 'Live', Remix: 'Remix', Soundtrack: 'BO', 'DJ-mix': 'DJ-mix', 'Mixtape/Street': 'Mixtape', Demo: 'Demo', Audiobook: 'Audiobook', Interview: 'Interview', Spokenword: 'Spoken' };
function mbTypeBadge(a) {
  const parts = [];
  if (a.mb_release_type && a.mb_release_type !== 'Album') parts.push(MB_TYPE_LABELS[a.mb_release_type] || a.mb_release_type);
  (a.mb_release_secondary_types || []).forEach(t => parts.push(MB_SECONDARY_LABELS[t] || t));
  if (!parts.length) return '';
  return ` <span title="Type MusicBrainz : ${escAttr([a.mb_release_type, ...(a.mb_release_secondary_types||[])].filter(Boolean).join(', '))}" style="font-size:9px;color:var(--purple);border:1px solid rgba(176,140,255,0.3);border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">${esc([...new Set(parts)].join(' · '))}</span>`;
}

// Badge année d'édition originale (todo section 6, "croisement master release Discogs comme
// 2e source") : croise mb_original_year (release-group MusicBrainz, déjà en place) avec
// discogs_master_year (master release Discogs, nouveau). N'affiche rien si les deux sont
// absents ou si l'année d'origine == année de l'édition en collection (rien à signaler).
// Si les deux sources sont présentes et divergent, le signale en ambre plutôt que de choisir
// silencieusement l'une des deux — comme le reste des comparaisons multi-source de l'app.
function origYearBadge(a) {
  const mb = a.mb_original_year ? String(a.mb_original_year) : '';
  const dc = a.discogs_master_year ? String(a.discogs_master_year) : '';
  if (!mb && !dc) return '';
  const year = String(a.year || '');
  if (mb && dc && mb !== dc) {
    return ` <span title="Année de première parution : MusicBrainz dit ${mb}, Discogs (master release) dit ${dc} — sources en désaccord" style="font-size:10px;color:var(--amber);cursor:help">(orig. MB:${mb} ≠ DC:${dc} ⚠️)</span>`;
  }
  const orig = mb || dc;
  if (orig === year) return '';
  const srcLabel = mb && dc ? 'MusicBrainz + Discogs' : (mb ? 'MusicBrainz' : 'Discogs (master release)');
  return ` <span title="Année de première parution selon ${srcLabel} : ${orig}" style="font-size:10px;color:var(--text3);cursor:help">(orig. ${orig})</span>`;
}

// Échappe un id (normalizeKey texte) pour usage dans un attribut onclick HTML
// ex: "o'brother|||where art thou" → "o\\'brother|||where art thou"
function sid(id) {
  // Encoder en base64 pour éviter tout problème de caractères spéciaux dans onclick
  return btoa(unescape(encodeURIComponent(String(id||''))));
}

// Décoder côté réception — à utiliser dans toutes les fonctions qui reçoivent un id via sid()
function unsid(encoded) {
  try { return decodeURIComponent(escape(atob(encoded))); } catch(e) { return encoded; }
}

function updateStats() {
  document.getElementById('s-total').textContent = albums.length;
  document.getElementById('s-cd').textContent = albums.filter(a => a.cd).length;
  document.getElementById('s-num').textContent = albums.filter(a => a.flac || a.mp3 || a.digital).length;
  const rated = albums.filter(a => a.note > 0);
  document.getElementById('s-avg').textContent = rated.length
    ? (rated.reduce((s, a) => s + a.note, 0) / rated.length).toFixed(1) : '–';
  document.getElementById('s-plays').textContent = albums.reduce((s, a) => s + (a.plays || 0), 0).toLocaleString('fr-FR');
  document.getElementById('storage-pct').textContent = albums.length + ' albums';
  document.getElementById('storage-bar').style.width = Math.min(100, albums.length / 5) + '%';
}

function updateGenreFilter() {
  const sel = document.getElementById('filter-genre');
  const cur = sel.value;
  const genres = genreList();
  sel.innerHTML = '<option value="">Tous genres</option>' + genres.map(g => `<option value="${esc(g)}" ${g===cur?'selected':''}>${esc(g)}</option>`).join('');
}

function updateArtistFilter() {
  // filter-artist est maintenant un input texte — pas de <select> à remplir

  const sel2 = document.getElementById('filter-track-artist');
  if (sel2) {
    const cur2 = sel2.value;
    const tArtists = trackArtistList();
    sel2.innerHTML = '<option value="">Tous artistes</option>' + tArtists.map(a => `<option value="${esc(a)}" ${a===cur2?'selected':''}>${esc(a)}</option>`).join('');
  }
}

function rateAlbum(id, note) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (a) {
    a.note = a.note === note ? 0 : note;
    // v2026.07.09 : la notation classique (clic étoiles Collection) alimente désormais
    // "Notes à reporter" au même titre que la Session notation — jusqu'ici scopée à cette
    // dernière (cf. todo section 10, "actuellement scopé à la Session notation uniquement").
    if (a.note > 0) { queueNoteToReport('album', a, a.note); updateNavBadges(); }
    renderAlbums();
    saveToStorage();
  }
}

function rateDiscogs(id, note) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (a) {
    a.discogsRating = a.discogsRating === note ? 0 : note;
    renderAlbums();
    if (typeof renderDiscographie === 'function') renderDiscographie();
    saveToStorage();
  }
}

function promptDiscogsRating(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  const raw = prompt('Note Discogs (0 à 5, pas de 0.5) :', a.discogsRating || '');
  if (raw === null) return;
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') { a.discogsRating = 0; }
  else {
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)'); return; }
    a.discogsRating = Math.round(n * 2) / 2;
  }
  renderAlbums();
  if (typeof renderDiscographie === 'function') renderDiscographie();
  saveToStorage();
}

function promptStockRating(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  const raw = prompt('Note MusicBee (0 à 5, demi-étoiles possibles) :', a.note || '');
  if (raw === null) return;
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') { a.note = 0; }
  else {
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)'); return; }
    a.note = Math.round(n * 2) / 2;
  }
  if (a.note > 0) { queueNoteToReport('album', a, a.note); updateNavBadges(); }
  renderAlbums();
  if (typeof renderStock === 'function') renderStock();
  saveToStorage();
}

// deleteAlbum supprimée (v2026.07.10-03) — plus aucun bouton n'y mène ; les
// suppressions d'albums passent désormais uniquement par le réimport MusicBee/Discogs
// (un album qui disparaît du XML/CSV disparaît de la collection au réimport, cf.
// gestion des "ghostAlbums" dans l'import XML).

function prevPage() { if (currentPage > 1) { currentPage--; renderAlbums(); } }
function nextPage() {
  const pages = Math.ceil(filteredAlbums().length / PAGE_SIZE);
  if (currentPage < pages) { currentPage++; renderAlbums(); }
}

// ===================== TRACKS =====================
// ===================== SÉLECTION MULTIPLE / ACTIONS GROUPÉES (Morceaux isolés) =====================
let selectedTrackIds = new Set();

function toggleTrackSelected(idSid, checked) {
  const id = unsid(idSid);
  const t = tracks.find(x => x.id === id);
  const realId = t ? t.id : id;
  if (checked) selectedTrackIds.add(realId); else selectedTrackIds.delete(realId);
  renderTrackBulkBar();
}

function toggleSelectAllTracks(checked) {
  document.querySelectorAll('#tracks-tbody .row-select').forEach(cb => {
    cb.checked = checked;
    const id = unsid(cb.dataset.id);
    const t = tracks.find(x => x.id === id);
    const realId = t ? t.id : id;
    if (checked) selectedTrackIds.add(realId); else selectedTrackIds.delete(realId);
  });
  renderTrackBulkBar();
}

function clearTrackSelection() {
  selectedTrackIds.clear();
  document.querySelectorAll('#tracks-tbody .row-select').forEach(cb => { cb.checked = false; });
  const selAllCb = document.getElementById('select-all-tracks');
  if (selAllCb) selAllCb.checked = false;
  renderTrackBulkBar();
}

function renderTrackBulkBar() {
  const bar = document.getElementById('bulk-actions-bar-tracks');
  const countEl = document.getElementById('bulk-actions-count-tracks');
  if (!bar) return;
  const n = selectedTrackIds.size;
  if (countEl) countEl.textContent = n ? `${n} morceau${n > 1 ? 'x' : ''} sélectionné${n > 1 ? 's' : ''}` : '';
  bar.style.display = n ? 'flex' : 'none';
}

// bulkDeleteTracks supprimée (v2026.07.10-03) — idem.

function renderTracks() {
  // Dédoublonner (titre+artiste)
  const seen = new Map();
  tracks.forEach(t => {
    const k = (t.title+'|'+t.artist).toLowerCase().trim();
    const prev = seen.get(k);
    if (!prev || t.id > prev.id) seen.set(k, t);
  });
  if (seen.size < tracks.length) { tracks = Array.from(seen.values()); saveToStorage(); }

  const lfExact = getLfExactMap();

  const q      = document.getElementById('global-search').value.toLowerCase();
  const af     = (document.getElementById('filter-track-artist')?.value || '').toLowerCase().trim();
  const tf     = (document.getElementById('filter-track-title')?.value  || '').toLowerCase().trim();
  const albf   = (document.getElementById('filter-track-album')?.value  || '').toLowerCase().trim();
  const ff     = document.getElementById('filter-track-format').value;
  const nf     = document.getElementById('filter-track-note')?.value || '';
  const lf     = document.getElementById('filter-track-lastfm')?.value || '';
  const minPlf = parseInt(document.getElementById('filter-track-min-plays')?.value || '0') || 0;
  const sortF  = document.getElementById('filter-track-sort')?.value || 'artist';

  let list = tracks.filter(t => {
    const m   = !q    || (t.title+' '+t.artist+' '+(t.album||'')).toLowerCase().includes(q);
    const am  = !af   || t.artist.toLowerCase().includes(af);
    const tm  = !tf   || t.title.toLowerCase().includes(tf);
    const alm = !albf || (t.album||'').toLowerCase().includes(albf);
    const fm  = !ff   || t.format === ff;
    let nm = true;
    if (nf==='5') nm = t.note===5;
    else if (nf==='4') nm = t.note>=4;
    else if (nf==='3') nm = t.note>=3;
    else if (nf==='0') nm = !t.note;
    const plays = lfExact.get(normalizeKey(t.artist, t.title)) || 0;
    const hasLf = plays > 0;
    const isLoved = _lovedTracks.has(normalizeKey(t.artist, t.title));
    let lfm = true;
    if (lf==='present') lfm = hasLf;
    else if (lf==='absent') lfm = !hasLf;
    else if (lf==='loved') lfm = isLoved;
    const plm = plays >= minPlf;
    return m && am && tm && alm && fm && nm && lfm && plm;
  });

  if (sortF === 'plays')   list.sort((a,b) => (lfExact.get(normalizeKey(b.artist,b.title))||0) - (lfExact.get(normalizeKey(a.artist,a.title))||0));
  else if (sortF === 'title')   list.sort((a,b) => a.title.localeCompare(b.title,'fr'));
  else if (sortF === 'note')    list.sort((a,b) => (b.note||0) - (a.note||0));
  else if (sortF === 'bitrate') list.sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
  else list.sort((a,b) => a.artist.localeCompare(b.artist,'fr'));

  const ctr = document.getElementById('tracks-counter');
  if (ctr) ctr.textContent = list.length+' / '+tracks.length+' morceaux';

  const tbody = document.getElementById('tracks-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-icon">🎵</div>Aucun morceau isolé</div></td></tr>';
    renderTrackBulkBar();
    return;
  }
  const fmtBadge = { flac:'badge-flac', mp3:'badge-mp3', aac:'badge-digital', autre:'badge-digital' };
  tbody.innerHTML = list.map(t => {
    const tSid = sid(t.id);
    const stars = [1,2,3,4,5].map(i =>
      `<button class="star ${(t.note||0)>=i?'on':''}" onclick="rateTrack('${tSid}',${i});event.stopPropagation()">★</button>`
    ).join('');
    const plays = lfExact.get(normalizeKey(t.artist, t.title)) || 0;
    const playsHtml = plays
      ? `<span class="mono" style="font-size:12px;color:var(--accent)">${plays}</span>`
      : `<span style="color:var(--text3);font-size:11px">–</span>`;
    const bitrateHtml = t.bitrate
      ? `<span class="mono" style="font-size:11px;color:var(--text3)">${t.bitrate}k</span>`
      : `<span style="color:var(--text3);font-size:11px">–</span>`;
    const lovedBadge = _lovedTracks.has(normalizeKey(t.artist, t.title))
      ? ' <span style="font-size:11px" title="Lové sur last.fm">❤️</span>' : '';
    return `<tr>
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="${tSid}" ${selectedTrackIds.has(t.id) ? 'checked' : ''} onchange="toggleTrackSelected('${tSid}', this.checked)"></td>
      <td style="font-weight:500">${esc(t.title)}${lovedBadge}</td>
      <td style="color:var(--text2);font-size:13px">${esc(t.artist)}</td>
      <td style="color:var(--text3);font-size:12px">${esc(t.album||'–')}</td>
      <td><span class="badge ${fmtBadge[t.format]||'badge-digital'}">${(t.format||'?').toUpperCase()}</span></td>
      <td>${bitrateHtml}</td>
      <td>${playsHtml}</td>
      <td><div class="stars">${stars}</div></td>
      <td onclick="event.stopPropagation()"><button class="btn btn-sm" onclick="listenToIsolatedTrack('${tSid}')" title="${t.mb_recording_id ? 'Écouter sur YouTube Music (lien direct MusicBrainz si disponible)' : 'Chercher sur YouTube Music'}">▶️</button></td>
    </tr>`;
  }).join('');
  renderTrackBulkBar();
  const selAllCb = document.getElementById('select-all-tracks');
  if (selAllCb) selAllCb.checked = list.length > 0 && list.every(t => selectedTrackIds.has(t.id));
}

function rateTrack(idSid, note) {
  const id = unsid(idSid);
  const t = tracks.find(x => x.id === id);
  if (t) {
    t.note = t.note === note ? 0 : note;
    if (t.note > 0) { queueNoteToReport('track', t, t.note); updateNavBadges(); }
    renderTracks();
    saveToStorage();
  }
}

// deleteTrack supprimée (v2026.07.10-03) — idem.

// ===================== CACHE =====================
let _cache = {};

function invalidateCache() {
  _cache = {};
  delete _debouncedRenders['allTracks'];
}

// Debounce : attend `delay` ms d'inactivité avant d'appeler fn
function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}
const _debouncedRenders = {};
function debouncedRender(name, fn, delay = 300) {
  if (!_debouncedRenders[name]) _debouncedRenders[name] = debounce(fn, delay);
  return _debouncedRenders[name];
}

// Cache de la Map last.fm tracks (coûteuse à reconstruire)
function getLfExactMap() {
  if (_cache.lfExact) return _cache.lfExact;
  _cache.lfExact = new Map(
    Object.values(_lastfmTrackCounts).map(d => [normalizeKey(d.artist, d.track), d.plays])
  );
  return _cache.lfExact;
}

function getOwnedKeysSet() {
  if (_cache.ownedKeys) return _cache.ownedKeys;
  _cache.ownedKeys = new Set();
  _cache.ownedMbIds = new Set();
  albums.forEach(a => {
    const albumNorm = normalizeKey('', a.album).replace('|||', '');
    for (const av of artistVariants(a.artist)) {
      _cache.ownedKeys.add(av + '|||' + albumNorm);
    }
    _cache.ownedKeys.add(normalizeKey(a.artist, a.album));
    if (a.lastfmAliases) a.lastfmAliases.forEach(k => _cache.ownedKeys.add(k));
    if (a.mb_release_id) _cache.ownedMbIds.add(a.mb_release_id);
  });
  // Inclure aussi les albums en stock (déjà "possédés", juste pas encore écoutés)
  stockItems.forEach(s => {
    const albumNorm = normalizeKey('', s.album).replace('|||', '');
    for (const av of artistVariants(s.artist)) {
      _cache.ownedKeys.add(av + '|||' + albumNorm);
    }
    _cache.ownedKeys.add(normalizeKey(s.artist, s.album));
  });
  return _cache.ownedKeys;
}

// ── Statuts last.fm albums ──────────────────────────────────────────
let _lastfmStatus = {}; // { key: 'ignored'|'to_listen'|'wishlist' }
let _lastfmTrackStatus = {}; // { normalizeKey(artist,track): { status, linkedTrackId, linkedAlbumId, linkedTrackTitle } }

function getLastfmStatus(artist, album) {
  const k = normalizeKey(artist, album);
  if (wishlist.find(w => normalizeKey(w.artist, w.album) === k)) return 'wishlist';
  return _lastfmStatus[k] || '';
}

function setLastfmStatus(artist, album, status) {
  const k = normalizeKey(artist, album);
  if (status) _lastfmStatus[k] = status;
  else delete _lastfmStatus[k];
  if (status === 'wishlist') {
    const d = lastfmData.find(x => normalizeKey(x.artist, x.album) === k);
    if (d && !wishlist.find(w => normalizeKey(w.artist, w.album) === k)) {
      addToWishlist(d.artist, d.album, '', 'lastfm', d.plays, 0, '');
    }
  } else {
    // Statut retiré explicitement (bouton 🎯 décoché) : retirer aussi de wishlist[] si présent,
    // sinon l'album y reste indéfiniment et le badge "wishlist" ne disparaît jamais.
    const before = wishlist.length;
    wishlist = wishlist.filter(w => normalizeKey(w.artist, w.album) !== k);
    if (wishlist.length !== before) saveToStorage();
  }
  if (window._sb) {
    window._sb.from('meta').upsert(
      { key: 'lastfm_status', value: JSON.stringify(_lastfmStatus) },
      { onConflict: 'key' }
    ).then(() => {});
  }
  invalidateCache();
  renderMissing();
  updateNavBadges();
}

function computeMissing() {
  if (_cache.missing) return _cache.missing;
  if (!lastfmData.length) return (_cache.missing = []);
  const owned = getOwnedKeysSet();
  // lastfmAliases déjà indexés dans getOwnedKeysSet via ownedKeys
  const ownedMbIds = _cache.ownedMbIds || new Set();
  // Filet de sécurité : fusionner les doublons de casse ("Luck In The Valley" vs
  // "Luck in the Valley") avant affichage, même si le nettoyage Supabase n'a pas
  // encore été lancé (bouton "🧹 Nettoyer les doublons last.fm" dans Import/Export).
  const dedup = new Map();
  lastfmData.forEach(d => {
    if (!d.artist || !d.album) return;
    if (typeof d.album !== 'string' || d.album === '[object Object]') return;
    const k = normalizeKey(d.artist, d.album);
    const prev = dedup.get(k);
    if (!prev) {
      dedup.set(k, { artist: d.artist, album: d.album, plays: d.plays || 0, mb_release_id: d.mb_release_id, _best: d.plays || 0 });
    } else {
      prev.plays += (d.plays || 0);
      if ((d.plays || 0) > prev._best) { prev._best = d.plays || 0; prev.artist = d.artist; prev.album = d.album; }
      if (!prev.mb_release_id && d.mb_release_id) prev.mb_release_id = d.mb_release_id;
    }
  });
  _cache.missing = [...dedup.values()]
    .filter(d => {
      if (owned.has(normalizeKey(d.artist, d.album))) return false;
      if (d.mb_release_id && ownedMbIds.has(d.mb_release_id)) return false;
      return true;
    })
    .sort((a, b) => b.plays - a.plays);
  return _cache.missing;
}

let _navBadgeTimer = null;
let _dataReady = false; // flag : données chargées depuis Supabase/localStorage

function updateNavBadges() {
  clearTimeout(_navBadgeTimer);
  _navBadgeTimer = setTimeout(() => {
    if (_dataReady && !_restoringSnapshot) pruneWishlistOwned();
    if (_dataReady && !_restoringSnapshot && notesToReport.length) pruneNotesToReport();
    document.getElementById('nav-albums-count').textContent = albums.filter(a => !getStockKeysSet().has(normalizeKey(a.artist, a.album))).length;
    document.getElementById('nav-tracks-count').textContent = tracks.length;
    const wishBadge = document.getElementById('nav-wish-count');
    if (wishBadge) wishBadge.textContent = wishlist.length;
    const missingTracksBadge = document.getElementById('nav-missing-tracks-count');
    if (missingTracksBadge && _cache.missingTracks) missingTracksBadge.textContent = _cache.missingTracks.length;
    const okBadge = document.getElementById('nav-ok-count');
    if (okBadge) okBadge.textContent = albums.filter(a=>a.okFolder).length;
    const fsaleBadge = document.getElementById('nav-forsale-count');
    if (fsaleBadge) fsaleBadge.textContent = albums.filter(a=>a.forSale).length;
    const twBadge = document.getElementById('nav-track-wish-count');
    if (twBadge) twBadge.textContent = trackWishlist.length;
    const assocBadge = document.getElementById('nav-assoc-count');
    if (assocBadge) {
      const total = associations.length + rymAssociations.length + albums.reduce((s, a) => s + (a.lastfmAliases?.length || 0), 0);
      assocBadge.textContent = total;
    }
    const stockBadge = document.getElementById('nav-stock-count');
    if (stockBadge) stockBadge.textContent = stockItems.length;
    const coversBadge = document.getElementById('nav-covers-count');
    if (coversBadge) coversBadge.textContent = ownedAlbumsForCovers().filter(a => !a.cover_url).length;
    const completenessBadge = document.getElementById('nav-completeness-count');
    if (completenessBadge) completenessBadge.textContent = ownedAlbumsForCovers().filter(a => computeAlbumCompleteness(a).score <= 2).length;
    const rsBadge = document.getElementById('nav-ratesession-count');
    if (rsBadge) rsBadge.textContent = ownedAlbumsForCovers().filter(a => !a.note).length + tracks.filter(t => !t.note).length;
    const ntrBadge = document.getElementById('nav-notestoreport-count');
    if (ntrBadge) ntrBadge.textContent = notesToReport.length;
    const loansBadge = document.getElementById('nav-loans-count');
    if (loansBadge) loansBadge.textContent = albums.filter(a => a.loaned_to).length;
    if (document.getElementById('sec-loans')?.classList.contains('active')) renderLoans();
    if (document.getElementById('sec-notestoreport')?.classList.contains('active')) renderNotesToReport();
    // Calculs coûteux uniquement si données chargées
    if (_dataReady) {
      document.getElementById('nav-missing-count').textContent = computeMissing().length;
      const rymBadge = document.getElementById('nav-rym-count');
      if (rymBadge && rymData.length) rymBadge.textContent = computeRYMMissing().length;
      const discoBadge = document.getElementById('nav-disco-warn');
      if (discoBadge) discoBadge.textContent = getCDsWithoutBackup().length;
    }
  }, 80);
}

// Invalider le cache après toute mutation
function saveToStorage() {
  invalidateCache();
  _saveToStorageImpl();
}



function renderMissing() {
  const list = computeMissing();

  const globalQ = document.getElementById('global-search').value.toLowerCase();
  const af     = (document.getElementById('filter-missing-artist')?.value || '').toLowerCase().trim();
  const albf   = (document.getElementById('filter-missing-album')?.value  || '').toLowerCase().trim();
  const minP   = parseInt(document.getElementById('filter-missing-plays')?.value || '0') || 0;
  const statusF= document.getElementById('filter-missing-status')?.value || '';
  const genreF = (document.getElementById('filter-missing-genre')?.value  || '').toLowerCase().trim();
  const rymF   = document.getElementById('filter-missing-rym')?.value || '';
  const sortF  = document.getElementById('filter-missing-sort')?.value || 'plays';
 
  // Remplir le select genre une seule fois (genre récupéré via RYM, lastfmData n'en a pas)
  const genreSel = document.getElementById('filter-missing-genre');
  if (genreSel && genreSel.options.length <= 1) {
    const genres = [...new Set(
      list.flatMap(m => {
        const r = lookupRym(m.artist, m.album);
        return (r?.genre || '').split(',').map(g => g.trim()).filter(Boolean);
      })
    )].sort();
    const frag = document.createDocumentFragment();
    genres.forEach(g => { const o = document.createElement('option'); o.value = g.toLowerCase(); o.textContent = g; frag.appendChild(o); });
    genreSel.appendChild(frag);
  }

  // Clés wishlist réelles (source de vérité pour l'indication visuelle, cf. ci-dessous)
  const wishlistKeys = new Set(wishlist.map(w => normalizeKey(w.artist, w.album)));

  let filtered = list.filter(m => {
    const key = normalizeKey(m.artist, m.album);
    const rymEntry = lookupRym(m.artist, m.album);
    m._rymEntry = rymEntry;
    const genre = (rymEntry?.genre || '').toLowerCase();
    // Le statut 'wishlist' doit refléter la présence réelle dans wishlist[] (source de vérité),
    // pas seulement _lastfmStatus — sinon un album ajouté à la wishlist par un autre chemin
    // (bouton manuel, page RYM...) n'affiche aucune indication ici alors qu'il y est bien.
    const st = wishlistKeys.has(key) ? 'wishlist' : (_lastfmStatus[key] || '');
    if (statusF === 'none'      && st)               return false;
    if (statusF === 'ignored'   && st !== 'ignored')  return false;
    if (statusF === 'to_listen' && st !== 'to_listen') return false;
    if (statusF === 'wishlist'  && st !== 'wishlist')  return false;
    if (globalQ && !(m.artist+' '+m.album).toLowerCase().includes(globalQ)) return false;
    if (af   && !m.artist.toLowerCase().includes(af))  return false;
    if (albf && !m.album.toLowerCase().includes(albf)) return false;
    if (genreF && !genre.includes(genreF)) return false;
    if (m.plays < minP) return false;
    const hasRymRating = (rymEntry?.rating || 0) > 0;
		if (rymF === 'rym'   && !hasRymRating) return false;
		if (rymF === 'norym' && hasRymRating)  return false;
		const missingYearF = (document.getElementById('filter-missing-year')?.value || '').trim();
		if (missingYearF && !(rymEntry?.year||'').startsWith(missingYearF)) return false;
		if (rymF === 'low') {
          if ((rymEntry?.rating || 0) === 0 || (rymEntry?.rating || 0) > 2.5) return false;
        } else if (rymF && !isNaN(parseFloat(rymF))) {
          const threshold = parseFloat(rymF);
          if ((rymEntry?.rating || 0) < threshold) return false;
        }
    return true;
  });

  if (sortF === 'artist') filtered.sort((a,b) => a.artist.localeCompare(b.artist,'fr'));
  else if (sortF === 'album') filtered.sort((a,b) => a.album.localeCompare(b.album,'fr'));
  else if (sortF === 'plays') filtered.sort((a,b) => (b.plays||0) - (a.plays||0));

  _missingListCache = filtered;

  const ctr = document.getElementById('missing-counter');
  if (ctr) ctr.textContent = filtered.length + ' / ' + list.length + ' manquants';

  const el = document.getElementById('missing-grid');
  if (!el) return;

  if (!lastfmData.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📊</div>Aucun historique last.fm chargé.</div>';
    return;
  }
  if (!filtered.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">✅</div>Aucun manquant avec ces filtres.</div>';
    return;
  }

  // Rendu par chunks via requestAnimationFrame pour ne pas geler l'UI
  // Token de génération : annule les renders précédents encore en cours
  const CHUNK = 80;
  el.innerHTML = '';
  const renderToken = (el._renderToken = (el._renderToken || 0) + 1);
  let chunkIdx = 0;

  function renderChunk() {
    // Si un nouveau render a démarré entre-temps, abandonner celui-ci
    if (el._renderToken !== renderToken) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(chunkIdx + CHUNK, filtered.length);
    for (; chunkIdx < end; chunkIdx++) {
      const m = filtered[chunkIdx];
      const idx = chunkIdx;
      const rymEntry = lookupRym(m.artist, m.album);
      const rymBadge = rymEntry
        ? `<span class="badge" style="font-size:10px;color:var(--amber);margin-left:4px">${rymEntry.rating ? rymEntry.rating.toFixed(2)+'★' : 'RYM'}</span>`
        : '';
      const rymGenre = rymEntry?.genre || '';
      const genreBadge = rymGenre
        ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">${esc(rymGenre.split(',')[0].trim())}</span>`
        : '';
      const st = wishlistKeys.has(normalizeKey(m.artist, m.album)) ? 'wishlist' : (_lastfmStatus[normalizeKey(m.artist, m.album)] || '');
      const stColors = { ignored:'var(--text3)', to_listen:'var(--accent)', wishlist:'var(--amber)' };
      const stLabels = { ignored:'🚫', to_listen:'👂', wishlist:'🎯' };
      const stBadge = st ? `<span style="font-size:11px;color:${stColors[st]}">${stLabels[st]}</span>` : '';
      const div = document.createElement('div');
      div.className = 'missing-card';
      div.style.cssText = `padding:10px 14px;gap:10px;opacity:${st==='ignored'?0.5:1}`;
      div.innerHTML = `
        <div class="missing-info" style="min-width:0;flex:1">
          <div class="title" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.album)} ${stBadge}</div>
          <div class="sub" style="font-size:11px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            <span>${esc(m.artist)}</span>
            <span class="mono" style="color:var(--accent)">${m.plays} écoute${m.plays>1?'s':''}</span>
            ${rymBadge}${genreBadge}
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm" data-idx="${idx}" data-action="assoc" title="Associer">🔗</button>
          <button class="btn btn-sm ${st==='ignored'?'btn-accent':''}" data-idx="${idx}" data-action="ignored" title="Ignorer">🚫</button>
          <button class="btn btn-sm ${st==='to_listen'?'btn-accent':''}" data-idx="${idx}" data-action="to_listen" title="À écouter">👂</button>
          <button class="btn btn-sm ${st==='wishlist'?'btn-accent':''}" data-idx="${idx}" data-action="wishlist" title="Wishlist">🎯</button>
          <button class="btn btn-sm" data-idx="${idx}" data-action="youtube" title="Chercher sur YouTube Music">▶️</button>
        </div>`;
      frag.appendChild(div);
    }
    el.appendChild(frag);
    if (chunkIdx < filtered.length) requestAnimationFrame(renderChunk);
  }

  requestAnimationFrame(renderChunk);
}

// Cible courante de l'association last.fm
let _lastfmAssocTarget = null; // { artist, album } depuis lastfmData

// Helper wishlist depuis missing (évite les problèmes d'encodage dans onclick)
function setLastfmStatusWishlist(idx) {
  const m = _missingListCache[idx];
  if (!m) return;
  const k = normalizeKey(m.artist, m.album);
  const current = getLastfmStatus(m.artist, m.album);
  const newStatus = current === 'wishlist' ? '' : 'wishlist';
  setLastfmStatus(m.artist, m.album, newStatus);
}

function setLastfmStatusFromMissing(idx, status) {
  const m = _missingListCache[idx];
  if (!m) return;
  const current = getLastfmStatus(m.artist, m.album);
  setLastfmStatus(m.artist, m.album, current === status ? '' : status);
}

function associateFromMissingIdx(idx) {
  const m = _missingListCache[idx];
  if (!m) return;
  _lastfmAssocTarget = { artist: m.artist, album: m.album };
  document.getElementById('lastfm-assoc-info').innerHTML =
    `<strong>last.fm :</strong> ${esc(m.album)} — ${esc(m.artist)} <span style="color:var(--accent);margin-left:8px">${m.plays} écoutes</span>`;
  document.getElementById('lastfm-assoc-search').value = m.artist;
  renderLastfmAssocList();
  document.getElementById('modal-lastfm-assoc').classList.add('open');
}

function renderLastfmAssocList() {
  const q = (document.getElementById('lastfm-assoc-search').value || '').toLowerCase().trim();
  const list = albums.filter(a => {
    if (!q) return true;
    return (a.artist + ' ' + a.album).toLowerCase().includes(q);
  }).slice(0, 30);
  const el = document.getElementById('lastfm-assoc-list');
  if (!list.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Aucun album trouvé</div>';
    return;
  }
  el.innerHTML = list.map(a => {
    const badges = [
      a.cd   ? '<span class="badge badge-cd">CD</span>'     : '',
      a.flac ? '<span class="badge badge-flac">FLAC</span>' : '',
      a.mp3  ? '<span class="badge badge-mp3">MP3</span>'   : '',
    ].filter(Boolean).join(' ');
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg3);border-radius:var(--radius);cursor:pointer" onclick="applyLastfmAssoc('${sid(a.id)}')">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.album)}</div>
        <div style="font-size:11px;color:var(--text2)">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">${badges}</div>
    </div>`;
  }).join('');
}

function applyLastfmAssoc(albumId) {
  if (!_lastfmAssocTarget) return;
  const realId = unsid(albumId);
  const album = albums.find(a => a.id === realId);
  if (!album) return;
  if (!album.lastfmAliases) album.lastfmAliases = [];
  const key = normalizeKey(_lastfmAssocTarget.artist, _lastfmAssocTarget.album);
  if (!album.lastfmAliases.includes(key)) album.lastfmAliases.push(key);
  document.getElementById('modal-lastfm-assoc').classList.remove('open');
  invalidateCache();
  saveToStorage();
  renderMissing();
  updateNavBadges();
  toast(`Associé : ${album.artist} — ${album.album}`);
  _lastfmAssocTarget = null;
}

function computeMissingTracks() {
  if (_cache.missingTracks) return _cache.missingTracks;
  if (!Object.keys(_lastfmTrackCounts).length) return [];
  // Ne pas cacher si musicbee_tracks pas encore chargé (évite faux positifs massifs)
  const mbReady = (window._mbTrackKeys && window._mbTrackKeys.size > 0)
               || Object.keys(albumTracksCache).length > 0;
  const canCache = mbReady;

  // 1. Morceaux isolés possédés (tracks[])
  const ownedIsolated = new Set();
  tracks.forEach(t => {
    for (const k of normalizeKeyLoose(t.artist, t.title)) ownedIsolated.add(k);
    const clean = cleanDiscogsArtist(t.artist);
    if (clean !== t.artist) {
      for (const k of normalizeKeyLoose(clean, t.title)) ownedIsolated.add(k);
    }
  });

  // 2. Pistes album — combinaison de toutes les sources disponibles
  // _mbTrackKeys (musicbee_tracks Supabase) peut être incomplet → toujours enrichir avec albumTracksCache
  const ownedAlbumTracks = new Set(window._mbTrackKeys || []);

  // Toujours ajouter albumTracksCache (source la plus complète en mémoire)
  albums.forEach(a => {
    (albumTracksCache[a.id] || []).forEach(t => {
      if (!t.title) return;
      const clean = cleanDiscogsArtist(a.artist);
      const noThe = (a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'');
      for (const art of [a.artist, clean, noThe]) {
        for (const k of normalizeKeyLoose(art, t.title)) ownedAlbumTracks.add(k);
      }
      // Compilations ("Various Artists") : l'album est groupé sous un artiste générique,
      // mais last.fm scrobble sous l'artiste RÉEL du morceau (tag Artist, stocké à part
      // dans trackArtist car ≠ Album Artist). Sans ça, aucun morceau de compilation
      // scrobblé sous son vrai artiste ne pouvait jamais matcher (ex: "Various Artists" vs
      // "Harry Nilsson" pour un morceau de la BO Forrest Gump).
      if (t.trackArtist && t.trackArtist !== a.artist) {
        const tClean = cleanDiscogsArtist(t.trackArtist);
        const tNoThe = t.trackArtist.replace(/^The\s+/i,'').replace(/^A\s+/i,'');
        for (const art of [t.trackArtist, tClean, tNoThe]) {
          for (const k of normalizeKeyLoose(art, t.title)) ownedAlbumTracks.add(k);
        }
      }
    });
  });

  // Enrichir aussi depuis _albumTracksByKey (stock, ok, forsale)
  if (window._albumTracksByKey) {
    Object.values(window._albumTracksByKey).forEach(g => {
      g.tracks.forEach(t => {
        if (!t.title) return;
        const clean = cleanDiscogsArtist(g.artist);
        const noThe = (g.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'');
        for (const art of [g.artist, clean, noThe]) {
          for (const k of normalizeKeyLoose(art, t.title)) ownedAlbumTracks.add(k);
        }
      });
    });
  }

  // Helper : vérifie si une clé normalisée (artiste, titre) est possédée
  // en testant plusieurs variantes d'artiste et de titre
  function isOwned(artist, track, ownedSet) {
    const trackVariants = normalizeKeyLoose(artist, track);
    for (const kv of trackVariants) {
      if (ownedSet.has(kv)) return true;
    }
    // Variantes artiste : nettoyé Discogs, sans The/A
    const cleanArt = cleanDiscogsArtist(artist);
    const noThe = artist.replace(/^The\s+/i,'').replace(/^A\s+/i,'');
    for (const art of [cleanArt, noThe]) {
      if (art === artist) continue;
      const vk = normalizeKeyLoose(art, track);
      for (const k of vk) { if (ownedSet.has(k)) return true; }
    }
    return false;
  }

  // 3. Filtrer les morceaux last.fm
  const filtered = Object.values(_lastfmTrackCounts)
    .filter(d => {
      if (!d.plays) return false;
      if (typeof d.artist !== 'string' || typeof d.track !== 'string') return false;
      if (d.artist === '[object Object]' || d.track === '[object Object]') return false;
      const keyTrack = normalizeKey(d.artist, d.track);
      // Le statut (ignoré/associé) n'est PAS filtré ici : computeMissingTracks() doit rester
      // la liste brute complète, sinon le filtre "🚫 Ignorés" de renderMissingTracks cherche
      // dans une liste qui ne les contient déjà plus (bug : morceau ignoré = inaccessible,
      // filtre "Ignorés" toujours vide). Le masquage par défaut se fait dans renderMissingTracks.
      // Matching prioritaire par recording_mbid (ListenBrainz)
      const recMbid = d.recording_mbid;
      if (recMbid && window._mbRecordingIds?.has(recMbid)) return false;
      // Morceau isolé
      if (isOwned(d.artist, d.track, ownedIsolated)) return false;
      // Dans musicbee_tracks / albumTracksCache
      if (isOwned(d.artist, d.track, ownedAlbumTracks)) return false;
      return true;
    });

  // Un même morceau peut avoir été scrobblé sous plusieurs tags Album différents
  // (single + compilation, typos...) — on consolide par (artiste, titre) pour éviter
  // d'afficher plusieurs fois "le même morceau manquant" avec des écoutes séparées.
  const grouped = new Map();
  filtered.forEach(d => {
    const key = normalizeKey(d.artist, d.track);
    // L'album peut être un objet brut de l'API last.fm ({ "#text": "...", mbid: "..." })
    // si un ancien enregistrement corrompu traîne encore — ne jamais le laisser passer tel
    // quel, sinon Set.add(objet) puis .join() produit littéralement le texte "[object Object]".
    const albumText = typeof d.album === 'string' ? d.album.trim() : '';
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, { artist: d.artist, track: d.track, plays: d.plays || 0,
        recording_mbid: d.recording_mbid, _albums: new Set(albumText ? [albumText] : []) });
    } else {
      prev.plays += (d.plays || 0);
      if (albumText) prev._albums.add(albumText);
      if (!prev.recording_mbid && d.recording_mbid) prev.recording_mbid = d.recording_mbid;
    }
  });
  const result = [...grouped.values()]
    .map(d => ({ artist: d.artist, track: d.track, plays: d.plays, recording_mbid: d.recording_mbid,
      album: [...d._albums].join(' / ') }))
    .sort((a, b) => b.plays - a.plays);

 if (canCache) _cache.missingTracks = result;
  return result;
}

function renderMissingTracks() {
  const q      = document.getElementById('global-search').value.toLowerCase();
  const af     = (document.getElementById('filter-mtrack-artist')?.value || '').toLowerCase().trim();
  const tf     = (document.getElementById('filter-mtrack-title')?.value  || '').toLowerCase().trim();
  const albf   = (document.getElementById('filter-mtrack-album')?.value  || '').toLowerCase().trim();
  const minP   = parseInt(document.getElementById('filter-mtrack-plays')?.value || '0') || 0;
  const sortF  = document.getElementById('filter-mtrack-sort')?.value || 'plays';
  const statusF= document.getElementById('filter-mtrack-status')?.value || '';

  const all = computeMissingTracks();
  let list = all.filter(d => {
    const key = normalizeKey(d.artist, d.track);
    const st  = _lastfmTrackStatus[key];
    let stMatch;
    if      (statusF === 'none')     stMatch = !st || !st.status;
    else if (statusF === 'ignored')  stMatch = st?.status === 'ignored';
    else if (statusF === 'wishlist') stMatch = st?.status === 'wishlist';
    else if (statusF === 'linked')   stMatch = st?.status === 'linked';
    // "Tous statuts" (par défaut) : masque ignorés/associés pour ne pas polluer la vue
    // générale — mais ils restent consultables via les filtres dédiés ci-dessus, ce qui
    // n'était plus le cas avant (computeMissingTracks les excluait en amont, sans retour possible).
    else stMatch = !(st?.status === 'ignored' || st?.status === 'linked');
    return (!q    || (d.artist+' '+d.track+' '+(d.album||'')).toLowerCase().includes(q))
        && (!af   || d.artist.toLowerCase().includes(af))
        && (!tf   || d.track.toLowerCase().includes(tf))
        && (!albf || (d.album||'').toLowerCase().includes(albf))
        && d.plays >= minP
        && stMatch;
  });

  if      (sortF === 'artist') list.sort((a,b) => a.artist.localeCompare(b.artist,'fr'));
  else if (sortF === 'title')  list.sort((a,b) => a.track.localeCompare(b.track,'fr'));
  else if (sortF === 'album')  list.sort((a,b) => (a.album||'').localeCompare(b.album||'','fr'));

  const ctr = document.getElementById('mtrack-counter');
  if (ctr) ctr.textContent = list.length.toLocaleString('fr-FR') + ' / ' + all.length.toLocaleString('fr-FR') + ' morceaux';

  const badge = document.getElementById('nav-missing-tracks-count');
  if (badge) {
    const visibleByDefault = all.filter(d => {
      const st = _lastfmTrackStatus[normalizeKey(d.artist, d.track)];
      return !(st?.status === 'ignored' || st?.status === 'linked');
    }).length;
    badge.textContent = visibleByDefault;
  }

  const tbody = document.getElementById('mtrack-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">🎵</div>' +
      (Object.keys(_lastfmTrackCounts).length ? 'Aucun résultat avec ces filtres.' : 'Lancez la "Sync morceaux complète" dans Import pour charger les données.') +
      '</div></td></tr>';
    return;
  }
  const slice = list.slice(0, 200);
  // Index des albums déjà en wishlist albums (clé normalisée artiste+album) — pour signaler
  // sur cette page morceaux si l'album d'un morceau manquant est déjà dans la wishlist albums,
  // ce qui n'était visible nulle part jusqu'ici (seul le statut morceau était indiqué).
  const wishlistAlbumKeys = new Set(wishlist.map(w => normalizeKey(w.artist, w.album)));
  tbody.innerHTML = slice.map((d, i) => {
    const key = normalizeKey(d.artist, d.track);
    const st  = _lastfmTrackStatus[key];
    const isIgnored  = st?.status === 'ignored';
    const isLinked   = st?.status === 'linked';
    const isWishlist = st?.status === 'wishlist';
    const stBadge = isIgnored  ? ' <span style="font-size:10px;color:var(--text3)">🚫</span>'
                  : isLinked   ? ' <span style="font-size:10px;color:var(--accent)">🔗</span>'
                  : isWishlist ? ' <span style="font-size:10px;color:var(--amber)">🎯</span>'
                  : '';
    // Un morceau peut avoir plusieurs tags Album différents (consolidés dans d.album,
    // séparés par " / ") — on marque dès qu'un de ces albums est dans la wishlist albums.
    const albumNames = (d.album || '').split(' / ').map(s => s.trim()).filter(Boolean);
    const albumInWishlist = albumNames.some(al => wishlistAlbumKeys.has(normalizeKey(d.artist, al)));
    const albumBadge = albumInWishlist
      ? ' <span style="font-size:10px;color:var(--amber)" title="Cet album est dans la wishlist albums">🎯💿</span>'
      : '';
    return `<tr style="opacity:${isIgnored ? 0.45 : 1}">
    <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-key="${sid(key)}" ${selectedMissingTrackKeys.has(key) ? 'checked' : ''} onchange="toggleMissingTrackSelected('${sid(key)}', this.checked)"></td>
    <td style="font-weight:500">${esc(d.track)}${stBadge}</td>
    <td style="color:var(--text2);font-size:13px">${esc(d.artist)}</td>
    <td style="color:var(--text3);font-size:12px">${esc(d.album||'–')}${albumBadge}</td>
    <td class="mono" style="color:var(--accent)">${d.plays}</td>
    <td style="display:flex;gap:3px;flex-wrap:wrap">
      <button class="btn btn-sm ${isIgnored?'btn-danger':''}" onclick="setMissingTrackStatus(${i},'ignored')" title="${isIgnored?'Retirer statut ignoré':'Ignorer'}">🚫</button>
      <button class="btn btn-sm ${isLinked?'btn-accent':''}" onclick="openTrackAssocModal(${i})" title="Associer à un morceau de la collection">🔗</button>
      <button class="btn btn-sm ${isWishlist?'btn-accent':''}" onclick="setMissingTrackStatus(${i},'wishlist')" title="${isWishlist?'Retirer de la wishlist':'Wishlist'}">🎯</button>
      <button class="btn btn-sm btn-accent" onclick="addTrackFromMissingIdx(${i})" title="Ajouter aux morceaux isolés">＋</button>
      <button class="btn btn-sm" onclick="openYouTubeMusicSearch(unsid('${sid(d.artist)}'), unsid('${sid(d.track)}'))" title="Chercher sur YouTube Music">▶️</button>
    </td>
  </tr>`;
  }).join('') + (list.length > 200 ? `<tr><td colspan="6" style="text-align:center;color:var(--text3);font-size:12px;padding:12px">… et ${(list.length-200).toLocaleString('fr-FR')} autres — affinez les filtres</td></tr>` : '');

  renderMissingTracks._cache = slice;
  const selAllCb = document.getElementById('select-all-mtracks');
  if (selAllCb) selAllCb.checked = slice.length > 0 && slice.every(d => selectedMissingTrackKeys.has(normalizeKey(d.artist, d.track)));
  renderMtrackBulkBar();
}

function addTrackFromMissingIdx(idx) {
  const d = renderMissingTracks._cache?.[idx];
  if (!d) return;
  if (tracks.find(t => normalizeKey(t.artist, t.title) === normalizeKey(d.artist, d.track))) {
    toast('Déjà dans les morceaux isolés', 'warn'); return;
  }
  tracks.push({ id: uid(), title: d.track, artist: d.artist, album: d.album || '', format: 'mp3', duration: '', note: 0 });
  invalidateCache();
  saveToStorage();
  renderMissingTracks();
  toast(`Ajouté : ${d.artist} — ${d.track}`);
}

// ── Sélection multiple & actions de masse (last.fm — Morceaux) ──────────────────────────
// Demandé par Antoine : jusqu'ici chaque action (🚫 Ignorer, 🎯 Wishlist, ＋ Ajouter) ne
// s'appliquait qu'à une ligne à la fois — fastidieux sur une longue liste de morceaux écoutés
// et jamais nettoyés depuis l'import last.fm. Même moule que la sélection multiple de l'onglet
// Albums (selectedAlbumIds/renderBulkActionsBar) mais clé de sélection = normalizeKey(artiste,
// titre) plutôt qu'un id — computeMissingTracks() reconstruit sa liste à chaque appel (pas
// d'id stable), et la clé texte survit aux changements de filtre/tri entre deux sélections,
// contrairement à un index de ligne qui redevient invalide dès qu'on retrie/filtre.
let selectedMissingTrackKeys = new Set();

function toggleMissingTrackSelected(keySid, checked) {
  const key = unsid(keySid);
  if (checked) selectedMissingTrackKeys.add(key); else selectedMissingTrackKeys.delete(key);
  renderMtrackBulkBar();
  const selAllCb = document.getElementById('select-all-mtracks');
  if (selAllCb) {
    const slice = renderMissingTracks._cache || [];
    selAllCb.checked = slice.length > 0 && slice.every(d => selectedMissingTrackKeys.has(normalizeKey(d.artist, d.track)));
  }
}

function toggleSelectAllMissingTracks(checked) {
  const slice = renderMissingTracks._cache || [];
  slice.forEach(d => {
    const key = normalizeKey(d.artist, d.track);
    if (checked) selectedMissingTrackKeys.add(key); else selectedMissingTrackKeys.delete(key);
  });
  renderMtrackBulkBar();
  document.querySelectorAll('#mtrack-tbody .row-select').forEach(cb => { cb.checked = checked; });
}

function clearMissingTrackSelection() {
  selectedMissingTrackKeys.clear();
  renderMissingTracks();
}

function renderMtrackBulkBar() {
  const n = selectedMissingTrackKeys.size;
  const bar = document.getElementById('mtrack-bulk-bar');
  if (!bar) return;
  const countEl = document.getElementById('mtrack-bulk-count');
  if (countEl) countEl.textContent = n ? `${n} morceau${n > 1 ? 'x' : ''} sélectionné${n > 1 ? 's' : ''}` : '';
  bar.style.display = n ? 'flex' : 'none';
}

// Réutilise la même sémantique toggle que setMissingTrackStatus (ré-appliquer le même statut
// à un morceau qui l'a déjà = le retirer) — cohérent avec le comportement ligne par ligne.
function bulkSetMissingTrackStatus(status) {
  if (!selectedMissingTrackKeys.size) return;
  const byKey = new Map(computeMissingTracks().map(d => [normalizeKey(d.artist, d.track), d]));
  let changed = 0, wishAdded = 0;
  selectedMissingTrackKeys.forEach(key => {
    const d = byKey.get(key);
    if (!d) return; // sélection issue d'un filtre différent, morceau plus dans la liste courante
    const current = _lastfmTrackStatus[key]?.status;
    if (current === status) {
      delete _lastfmTrackStatus[key];
    } else {
      if (!_lastfmTrackStatus[key]) _lastfmTrackStatus[key] = {};
      _lastfmTrackStatus[key].status = status;
      if (status === 'wishlist' && !trackWishlist.find(w => normalizeKey(w.artist, w.title) === key)) {
        trackWishlist.push({ id: uid(), artist: d.artist, title: d.track, album: d.album || '', prio: 'mid', addedAt: Date.now() });
        wishAdded++;
      }
    }
    changed++;
  });
  persistLastfmTrackStatus();
  if (wishAdded) { updateNavBadges(); saveToStorage(); }
  invalidateCache();
  clearMissingTrackSelection();
  const label = status === 'ignored' ? 'ignoré(s)/réactivé(s)' : status === 'wishlist' ? 'ajouté(s)/retiré(s) de la wishlist' : status;
  toast(`${changed} morceau(x) ${label}`);
}

function bulkAddMissingTracksToIsolated() {
  if (!selectedMissingTrackKeys.size) return;
  const byKey = new Map(computeMissingTracks().map(d => [normalizeKey(d.artist, d.track), d]));
  let added = 0, skipped = 0;
  selectedMissingTrackKeys.forEach(key => {
    const d = byKey.get(key);
    if (!d) return;
    if (tracks.find(t => normalizeKey(t.artist, t.title) === key)) { skipped++; return; }
    tracks.push({ id: uid(), title: d.track, artist: d.artist, album: d.album || '', format: 'mp3', duration: '', note: 0 });
    added++;
  });
  invalidateCache();
  saveToStorage();
  clearMissingTrackSelection();
  toast(`${added} morceau(x) ajouté(s) aux morceaux isolés${skipped ? ` — ${skipped} déjà présent(s)` : ''}`);
}

// ── Statuts morceaux last.fm ─────────────────────────────────────────────────
function setMissingTrackStatus(idx, status) {
  const d = renderMissingTracks._cache?.[idx];
  if (!d) return;
  const key = normalizeKey(d.artist, d.track);
  const current = _lastfmTrackStatus[key]?.status;
  if (current === status) {
    // Toggle off
    delete _lastfmTrackStatus[key];
  } else {
    if (!_lastfmTrackStatus[key]) _lastfmTrackStatus[key] = {};
    _lastfmTrackStatus[key].status = status;
    if (status === 'wishlist') addToWishlistFromMissingTrack(idx);
  }
  persistLastfmTrackStatus();
  invalidateCache();
  renderMissingTracks();
}

function persistLastfmTrackStatus() {
  try { localStorage.setItem('lastfm_track_status', JSON.stringify(_lastfmTrackStatus)); } catch(e) {}
  if (window._sb) {
    window._sb.from('meta').upsert(
      { key: 'lastfm_track_status', value: JSON.stringify(_lastfmTrackStatus) },
      { onConflict: 'key' }
    ).then(() => {});
  }
}

function loadLastfmTrackStatus() {
  try {
    const raw = localStorage.getItem('lastfm_track_status');
    if (raw) _lastfmTrackStatus = JSON.parse(raw) || {};
  } catch(e) {}
}

// ── Association morceau last.fm ↔ tous les morceaux ──────────────────────────
let _trackAssocTarget = null;

function openTrackAssocModal(idx) {
  const d = renderMissingTracks._cache?.[idx];
  if (!d) return;
  _trackAssocTarget = d;
  document.getElementById('track-assoc-info').innerHTML =
    `<strong>last.fm :</strong> ${esc(d.track)} — ${esc(d.artist)}`
    + (d.album ? ` <span style="color:var(--text3);font-size:11px;margin-left:6px">album : ${esc(d.album)}</span>` : '')
    + ` <span style="color:var(--accent);margin-left:8px;font-family:var(--mono);font-size:12px">${d.plays} écoutes</span>`;
  const artistWords = (d.artist || '').trim().split(/\s+/).slice(0, 2).join(' ');
const titleWord   = (d.track  || '').trim().split(/\s+/)[0];
document.getElementById('track-assoc-search').value = [artistWords, titleWord].filter(Boolean).join(' ');
  renderTrackAssocList();
  document.getElementById('modal-track-assoc').classList.add('open');
}

function renderTrackAssocList() {
  const q = (document.getElementById('track-assoc-search').value || '').toLowerCase().trim();
  const fmtBadge = { flac:'badge-flac', mp3:'badge-mp3', aac:'badge-digital', autre:'badge-digital' };
  const candidates = [];

  // 1. Morceaux isolés
  tracks.forEach(t => {
    if (!q || (t.artist + ' ' + t.title).toLowerCase().includes(q))
      candidates.push({ type:'isolated', id:t.id, title:t.title, artist:t.artist, album:t.album||'', format:t.format });
  });

  // 2. Pistes des albums (source musicbee en priorité, sinon discogs)
  const seenKey = new Set();
  albums.forEach(a => {
    const atracks = albumTracksCache[a.id] || [];
    const mbT = atracks.filter(t => t.source === 'musicbee');
    const useT = mbT.length ? mbT : atracks.filter(t => t.source === 'discogs');
    useT.forEach(t => {
      if (!t.title) return;
      const dk = normalizeKey(a.artist, t.title);
      if (seenKey.has(dk)) return;
      seenKey.add(dk);
      if (!q || (a.artist + ' ' + t.title + ' ' + a.album).toLowerCase().includes(q))
        candidates.push({ type:'album', albumId:a.id, title:t.title, artist:a.artist, album:a.album, format: a.flac?'flac':a.mp3?'mp3':'digital' });
    });
  });

  // Trier : correspondances exactes en premier
  if (_trackAssocTarget) {
    const tArtist = normalizeKey(_trackAssocTarget.artist, '');
    const tTitle  = normalizeKey('', _trackAssocTarget.track);
    candidates.sort((a, b) => {
      const sA = (normalizeKey('', a.title) === tTitle ? 4 : 0) + (normalizeKey(a.artist,'') === tArtist ? 2 : 0);
      const sB = (normalizeKey('', b.title) === tTitle ? 4 : 0) + (normalizeKey(b.artist,'') === tArtist ? 2 : 0);
      return sB - sA;
    });
  }

  const slice = candidates.slice(0, 60);
  const el = document.getElementById('track-assoc-list');
  if (!slice.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Aucun morceau trouvé</div>';
    return;
  }

  el.innerHTML = slice.map(t => {
    const srcLabel = t.type === 'isolated'
      ? `<span class="badge ${fmtBadge[t.format]||'badge-digital'}" style="font-size:9px">${(t.format||'?').toUpperCase()}</span>`
      : `<span class="badge badge-cd" style="font-size:9px;background:var(--accent-dim);color:var(--accent);border-color:rgba(200,240,100,0.2)">Album</span>`;
    const safeTitle = sid(t.title || '');
    const safeId = sid(String(t.id || ''));
    const safeAlbumId = sid(String(t.albumId || ''));
    const onclick = t.type === 'isolated'
      ? `applyTrackAssoc('isolated','${safeId}','')`
      : `applyTrackAssoc('album','${safeAlbumId}','${safeTitle}')`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg3);border-radius:var(--radius);cursor:pointer;border:1px solid var(--border)" onclick="${onclick}">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
        <div style="font-size:11px;color:var(--text2)">${esc(t.artist)}${t.album ? ' · <span style="color:var(--text3)">'+esc(t.album)+'</span>' : ''}</div>
      </div>
      ${srcLabel}
    </div>`;
  }).join('');
}

function applyTrackAssoc(type, idOrAlbumId, trackTitle) {
  if (!_trackAssocTarget) return;
  const realId = unsid(idOrAlbumId);
  const realTitle = unsid(trackTitle);
  const key = normalizeKey(_trackAssocTarget.artist, _trackAssocTarget.track);
  if (!_lastfmTrackStatus[key]) _lastfmTrackStatus[key] = {};
  _lastfmTrackStatus[key].status = 'linked';
  let label = '';
  if (type === 'isolated') {
    _lastfmTrackStatus[key].linkedTrackId = realId;
    const t = tracks.find(x => String(x.id) === String(realId));
    label = t ? `${t.artist} — ${t.title}` : 'morceau isolé';
  } else {
    _lastfmTrackStatus[key].linkedAlbumId = realId;
    _lastfmTrackStatus[key].linkedTrackTitle = realTitle;
    const a = albums.find(x => x.id === realId);
    label = a ? `${a.artist} — ${realTitle} (${a.album})` : realTitle;
  }
  document.getElementById('modal-track-assoc').classList.remove('open');
  persistLastfmTrackStatus();
  invalidateCache();
  renderMissingTracks();
  toast(`Associé : ${label}`);
  _trackAssocTarget = null;
}

// ── Export CSV morceaux last.fm manquants ─────────────────────────────────────
function exportMissingTracksCSV() {
  const all = computeMissingTracks();
  const statusLabel = { ignored:'Ignoré', wishlist:'Wishlist', linked:'Associé' };
  const rows = [['Artiste','Titre','Album','Écoutes last.fm','Statut']];
  all.forEach(d => {
    const key = normalizeKey(d.artist, d.track);
    const st  = _lastfmTrackStatus[key];
    rows.push([d.artist, d.track, d.album||'', d.plays, st?.status ? (statusLabel[st.status]||st.status) : '']);
  });
  const csv = rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\n');
  download(`lastfm_morceaux_${new Date().toISOString().slice(0,10)}.csv`, '\uFEFF'+csv, 'text/csv;charset=utf-8');
  toast(`${all.length} morceaux exportés ✓`);
}

function addToWishlistFromMissingTrack(idx) {
  const d = renderMissingTracks._cache?.[idx];
  if (!d) return;
  // Toujours ajouter à la wishlist MORCEAUX : on est sur l'écran "last.fm — Morceaux",
  // l'action 🎯 doit rester au niveau morceau, même si le morceau appartient à un album connu
  // (le tag album reste consultable dans la colonne Album de la wishlist morceaux).
  const key = normalizeKey(d.artist, d.track);
  if (trackWishlist.find(w => normalizeKey(w.artist, w.title) === key)) {
    toast('Déjà dans la wishlist morceaux', 'warn'); return;
  }
  trackWishlist.push({ id: uid(), artist: d.artist, title: d.track, album: d.album || '', prio: 'mid', addedAt: Date.now() });
  updateNavBadges();
  saveToStorage();
  toast(`Ajouté à la wishlist morceaux : ${d.artist} — ${d.track}`);
}

// Compat ancienne signature
function addTrackFromMissing(encodedArtist, encodedTitle) {
  const artist = decodeURIComponent(encodedArtist);
  const title  = decodeURIComponent(encodedTitle);
  if (tracks.find(t => normalizeKey(t.artist, t.title) === normalizeKey(artist, title))) {
    toast('Déjà dans les morceaux isolés', 'warn'); return;
  }
  tracks.push({ id: uid(), title, artist, album: '', format: 'mp3', duration: '', note: 0 });
  invalidateCache();
  saveToStorage();
  renderMissingTracks();
  toast(`Ajouté : ${artist} — ${title}`);
}

// addFromMissing (ajout manuel depuis Morceaux manquants) supprimée (v2026.07.10-03)
// — cohérence avec le principe "ajouts uniquement via imports MusicBee/Discogs".

// ===================== MODALS =====================
let _modalNote = 0;

function updateDiscogsLink() {
  const id = document.getElementById('f-discogs-id').value.trim();
  const el = document.getElementById('f-discogs-link');
  if (!el) return;
  if (id && /^\d+$/.test(id)) {
    el.innerHTML = `<a href="https://www.discogs.com/release/${id}" target="_blank" style="color:var(--blue);font-size:11px">→ discogs.com/release/${id}</a>`;
  } else {
    el.textContent = '';
  }
}

// openAlbumModal (ajout manuel d'un album) supprimée (v2026.07.10-03) — plus aucun
// bouton n'y mène, l'ajout d'albums passe uniquement par les imports MusicBee/Discogs.
// La modale reste utilisée en édition (editAlbum ci-dessous).

function editAlbum(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  document.getElementById('edit-id').value = realId;
  document.getElementById('modal-album-title').textContent = 'Modifier l\'album';
  document.getElementById('f-artist').value = a.artist;
  document.getElementById('f-album').value = a.album;
  document.getElementById('f-year').value = a.year || '';
  document.getElementById('f-genre').value = a.genre || '';
  document.getElementById('f-plays').value = a.plays || '';
  document.getElementById('f-notes').value = a.notes || '';
  document.getElementById('f-loaned-to').value = a.loaned_to || '';
  document.getElementById('f-loaned-since').value = a.loaned_since || '';
  document.getElementById('f-cd').checked = !!a.cd;
  document.getElementById('f-flac').checked = !!a.flac;
  document.getElementById('f-mp3').checked = !!a.mp3;
  document.getElementById('f-digital').checked = !!a.digital;
  document.getElementById('f-discogs-id').value = a.discogsId || '';
  if (document.getElementById('f-cover-url')) document.getElementById('f-cover-url').value = a.cover_url || '';
  const coverImg  = document.getElementById('modal-cover-img');
  const coverWrap = document.getElementById('modal-cover-wrap');
  if (a.cover_url && coverImg) { coverImg.src = a.cover_url; coverWrap.style.display = 'block'; }
  else if (coverWrap) coverWrap.style.display = 'none';
  updateDiscogsLink();
  setModalNote(a.note || 0);
  renderAlbumTracklistPanel(realId);
  renderMatchConfidencePanel(realId);
  renderProvenancePanel(realId);
  renderSourceComparisonPanel(realId);
  renderMbCreditsPanel(realId);
  const missingDiscogEl = document.getElementById('modal-missing-discog');
  if (missingDiscogEl) missingDiscogEl.innerHTML = '';
  _missingDiscogList = [];
  document.getElementById('modal-album').classList.add('open');
}

// ===================== AUTO COVERS =====================
let _coverFetchRunning = false;

async function fetchMissingCovers(albumList) {
  if (_coverFetchRunning) return;
  _coverFetchRunning = true;
  const lfKey = 'e8aae3c9ca05ced8f56443c1108fdc65';
  const missing = (albumList || albums).filter(a =>
    !a.cover_url && (a.flac || a.mp3 || a.digital || a.cd) && a.artist && a.album
    && !a.album.startsWith('byxsp')
    && a.album.trim().length > 1
    && a.artist.trim().length > 1
  );
  if (!missing.length) { _coverFetchRunning = false; return; }
  console.log(`Auto covers : ${missing.length} pochettes manquantes`);

  let fetched = 0;
  for (const album of missing) {
    if (!_coverFetchRunning) break;
    try {
      await new Promise(r => setTimeout(r, 220));
      // Nettoyer l'artiste : prendre la première partie avant "; " (tags multi-valeurs MusicBee)
      // et appliquer cleanDiscogsArtist (retire "(2)", inverse "X, The", etc.)
      const rawArtist = (album.artist || '').split(/\s*;\s*/)[0].trim();
      const artist = cleanDiscogsArtist(rawArtist);
      // Skipper les artistes non-latins (cyrillique, CJK, arabe…) — last.fm retourne 404
      if (/[^\u0000-\u024F]/.test(artist)) continue;
      const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album.album)}&api_key=${lfKey}&format=json`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const images = data.album?.image || [];
      const img = images.find(i => i.size === 'extralarge') || images.find(i => i.size === 'large');
      const imgUrl = img?.['#text'];
      if (imgUrl && !imgUrl.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
        album.cover_url = imgUrl;
        setProvenance(album, 'cover_url', 'lastfm');
        fetched++;
        // Mettre à jour avatars dans le DOM
        document.querySelectorAll(`[data-album-id="${album.id}"]`).forEach(el => {
          el.innerHTML = albumAvatar(album);
        });
        // Sauvegarder en Supabase par lots de 20
        if (fetched % 20 === 0 && window._sb) {
          const batch = missing.filter(a => a.cover_url).slice(fetched - 20, fetched);
          for (const a of batch) {
            await window._sb.from('albums').update({ cover_url: a.cover_url }).eq('id', a.id);
          }
          saveToStorage();
        }
      }
    } catch(e) { /* continuer */ }
  }

  // Flush final
  if (fetched > 0) {
    saveToStorage();
    if (window._sb) {
      const remaining = missing.filter(a => a.cover_url).slice(Math.floor(fetched / 20) * 20);
      for (const a of remaining) {
        await window._sb.from('albums').update({ cover_url: a.cover_url }).eq('id', a.id);
      }
    }
    console.log(`Auto covers : ${fetched} pochettes récupérées`);
    invalidateCache();
  }
  _coverFetchRunning = false;
}

function stopCoverFetch() { _coverFetchRunning = false; }

async function fetchCoverForModal() {
  const albumName  = (document.getElementById('f-album')?.value || '').trim();
  const artistName = (document.getElementById('f-artist')?.value || '').trim();
  const discogsId  = (document.getElementById('f-discogs-id')?.value || '').trim();
  if (!albumName) { toast('Renseignez le titre de l\'album', 'warn'); return; }
  try {
    let coverUrl = '';
    // 1. Discogs : retourne une URL directe i.discogs.com
    if (discogsId) {
      const data = await callEdgeFn({ source: 'discogs', release_id: discogsId });
      if (data.cover_url && !data.cover_url.includes('coverartarchive')) coverUrl = data.cover_url;
    }
    // 2. last.fm : album.getinfo retourne des URLs lastfm.freetls.fastly.net directes
    if (!coverUrl && artistName) {
      const lfKey = 'e8aae3c9ca05ced8f56443c1108fdc65';
      const rawArtistModal = (artistName || '').split(/\s*;\s*/)[0].trim();
      const lfUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(cleanDiscogsArtist(rawArtistModal))}&album=${encodeURIComponent(albumName)}&api_key=${lfKey}&format=json`;
      const res = await fetch(lfUrl);
      if (res.ok) {
        const data = await res.json();
        const images = data.album?.image || [];
        const img = images.find(i => i.size === 'extralarge') || images.find(i => i.size === 'large') || images.slice(-1)[0];
        if (img?.['#text'] && !img['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) coverUrl = img['#text'];
      }
    }
    if (coverUrl) {
      document.getElementById('f-cover-url').value = coverUrl;
      const img = document.getElementById('modal-cover-img');
      const wrap = document.getElementById('modal-cover-wrap');
      if (img) { img.src = coverUrl; wrap.style.display = 'block'; }
      toast('Pochette récupérée');
    } else {
      toast('Aucune pochette trouvée', 'warn');
    }
  } catch(e) { toast('Erreur : ' + e.message, 'error'); }
}

// ===================== GALERIE DE POCHETTES =====================
let coverFilter = 'missing';
let coverGalleryPage = 1;
const COVERS_PAGE_SIZE = 60;
let ratingQueue = []; // file d'ids albums non notés, ordre aléatoire (v2026.07.12-12)
const COVER_LOWRES_THRESHOLD = 300; // px — en dessous, considéré basse résolution

function ownedAlbumsForCovers() {
  return albums.filter(a => (a.flac || a.mp3 || a.digital || a.cd) && a.artist && a.album);
}

function setCoverFilter(f) {
  coverFilter = f;
  coverGalleryPage = 1;
  ['missing', 'lowres', 'all'].forEach(k => {
    document.getElementById('cf-btn-' + k).classList.toggle('active', k === f);
  });
  renderCoversGallery();
}

function updateCoversGenreFilter() {
  const sel = document.getElementById('covers-filter-genre');
  if (!sel) return;
  const cur = sel.value;
  const genres = genreList();
  sel.innerHTML = '<option value="">Tous genres</option>' + genres.map(g => `<option value="${esc(g)}" ${g===cur?'selected':''}>${esc(g)}</option>`).join('');
}

function resetCoversFilters() {
  document.getElementById('covers-search').value = '';
  document.getElementById('covers-filter-folder').value = '';
  document.getElementById('covers-filter-genre').value = '';
  document.getElementById('covers-filter-year-min').value = '';
  document.getElementById('covers-filter-year-max').value = '';
  document.getElementById('covers-sort').value = 'artist';
  coverGalleryPage = 1;
  renderCoversGallery();
}

function renderCoversGallery() {
  updateCoversGenreFilter();
  const q = (document.getElementById('covers-search')?.value || '').toLowerCase().trim();
  const folderF = document.getElementById('covers-filter-folder')?.value || '';
  const genreF = document.getElementById('covers-filter-genre')?.value || '';
  const yearMin = parseInt(document.getElementById('covers-filter-year-min')?.value, 10);
  const yearMax = parseInt(document.getElementById('covers-filter-year-max')?.value, 10);
  const sortBy = document.getElementById('covers-sort')?.value || 'artist';

  let list = ownedAlbumsForCovers();
  if (q) list = list.filter(a => a.artist.toLowerCase().includes(q) || a.album.toLowerCase().includes(q));
  if (folderF) list = list.filter(a => (a.folders || []).includes(folderF));
  if (genreF) list = list.filter(a => a.genre === genreF);
  if (!isNaN(yearMin)) list = list.filter(a => parseInt(a.year, 10) >= yearMin);
  if (!isNaN(yearMax)) list = list.filter(a => parseInt(a.year, 10) <= yearMax);

  if (coverFilter === 'missing') list = list.filter(a => !a.cover_url);
  else if (coverFilter === 'lowres') list = list.filter(a => a.cover_url && _cache.lowResCovers?.has(a.id));
  // 'all' : pas de filtre supplémentaire

  const sorters = {
    artist: (a, b) => (a.artist + a.album).localeCompare(b.artist + b.album),
    album:  (a, b) => (a.album + a.artist).localeCompare(b.album + b.artist),
    year:   (a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0) || a.artist.localeCompare(b.artist),
    genre:  (a, b) => (a.genre || '').localeCompare(b.genre || '') || a.artist.localeCompare(b.artist),
  };
  list.sort(sorters[sortBy] || sorters.artist);

  const counter = document.getElementById('covers-counter');
  const labels = { missing: 'sans pochette', lowres: 'en basse résolution', all: 'au total' };
  counter.textContent = `${list.length} album(s) ${labels[coverFilter]}`;

  const scanBtn = document.getElementById('btn-scan-lowres');
  if (scanBtn) scanBtn.style.display = coverFilter === 'lowres' ? 'inline-flex' : 'none';

  const shown = list.slice(0, coverGalleryPage * COVERS_PAGE_SIZE);
  const grid = document.getElementById('covers-grid');
  grid.innerHTML = shown.map(a => renderCoverCard(a)).join('') ||
    `<div style="grid-column:1/-1;color:var(--text3);font-size:13px;padding:20px 0">Rien à afficher${coverFilter === 'lowres' && !_cache.lowResScanned ? ' — clique sur "🔍 Scanner résolution" pour détecter les pochettes basse résolution.' : '.'}</div>`;

  const moreBtn = document.getElementById('btn-covers-more');
  moreBtn.style.display = list.length > shown.length ? 'inline-block' : 'none';
}

const FOLDER_ICONS = { discographie: '🎵', stock: '📦', ok: '✅', forsale: '💸' };

function renderCoverCard(a) {
  const flag = !a.cover_url
    ? '<span class="cover-flag missing">Sans pochette</span>'
    : (_cache.lowResCovers?.has(a.id) ? '<span class="cover-flag lowres">Basse rés.</span>' : '');
  const folderIcons = (a.folders || []).map(f => FOLDER_ICONS[f]).filter(Boolean).join(' ');
  const meta = [a.year, a.genre].filter(Boolean).join(' · ');
  return `<div class="cover-card" data-cover-id="${sid(a.id)}" onclick="openCoverChoiceModal('${sid(a.id)}')">
    ${flag}
    ${folderIcons ? `<span class="cover-flag" style="left:auto;right:6px;background:rgba(0,0,0,0.5)">${folderIcons}</span>` : ''}
    <div class="cover-thumb">${albumAvatar(a)}</div>
    <div class="name">${esc(a.album)}</div>
    <div class="sub">${esc(a.artist)}</div>
    ${meta ? `<div class="sub" style="opacity:0.7">${esc(meta)}</div>` : ''}
  </div>`;
}

// ===================== SCORE DE COMPLÉTUDE DE FICHE =====================
// Todo section 11, item ⬜ "Score de complétude de fiche (pochette / genre / note / tracklist
// présents) pour repérer les fiches négligées — variante des diagnostics existants (🩺, Pochettes)."
// 4 critères binaires, calculés 100% côté client à partir des données déjà chargées :
// albumTracksCache est rempli en bloc pour toute la collection au démarrage (loadAlbumTracks()),
// donc aucun appel réseau supplémentaire ici — contrairement au panneau tracklist de la fiche
// album qui, lui, ne fait que piocher dans ce même cache déjà prêt.
const COMPLETENESS_CRITERIA = [
  { key: 'cover',     check: a => !!a.cover_url },
  { key: 'genre',     check: a => !!(a.genre && a.genre.trim()) },
  { key: 'note',      check: a => !!a.note },
  { key: 'tracklist', check: a => !!(albumTracksCache[a.id] && albumTracksCache[a.id].length) },
];

function computeAlbumCompleteness(a) {
  const flags = {};
  let score = 0;
  COMPLETENESS_CRITERIA.forEach(c => { const ok = c.check(a); flags[c.key] = ok; if (ok) score++; });
  return { flags, score, max: COMPLETENESS_CRITERIA.length };
}

function completenessList() {
  return ownedAlbumsForCovers().map(a => ({ album: a, ...computeAlbumCompleteness(a) }));
}

let completenessPage = 1;
const COMPLETENESS_PAGE_SIZE = 50;

function resetCompletenessFilters() {
  document.getElementById('completeness-search').value = '';
  document.getElementById('completeness-hide-complete').checked = true;
  completenessPage = 1;
  renderCompleteness();
}

function loadMoreCompleteness() {
  completenessPage++;
  renderCompleteness();
}

function renderCompleteness() {
  const q = (document.getElementById('completeness-search')?.value || '').toLowerCase().trim();
  const hideComplete = document.getElementById('completeness-hide-complete')?.checked !== false;

  const full = completenessList();
  let list = full;
  if (q) list = list.filter(x => x.album.artist.toLowerCase().includes(q) || x.album.album.toLowerCase().includes(q));
  if (hideComplete) list = list.filter(x => x.score < x.max);
  // Pires fiches en premier (score croissant) — puis ordre alphabétique pour stabilité d'affichage.
  list.sort((x, y) => x.score - y.score || x.album.artist.localeCompare(y.album.artist) || x.album.album.localeCompare(y.album.album));

  const counter = document.getElementById('completeness-counter');
  const neglected = full.filter(x => x.score <= 2).length;
  if (counter) counter.textContent = `${list.length} fiche(s) affichée(s) — ${neglected} négligée(s) (≤ 2/4) sur ${full.length} album(s) possédé(s)`;

  const shown = list.slice(0, completenessPage * COMPLETENESS_PAGE_SIZE);
  const tbody = document.getElementById('completeness-tbody');
  if (tbody) {
    tbody.innerHTML = shown.map(x => {
      const a = x.album;
      const cell = (ok) => `<td style="text-align:center">${ok ? '<span style="color:var(--accent)">✓</span>' : '<span style="color:var(--text3);opacity:0.5">✗</span>'}</td>`;
      const pct = Math.round(x.score / x.max * 100);
      return `<tr onclick="editAlbum('${sid(a.id)}')" style="cursor:pointer">
        <td><div style="display:flex;align-items:center;gap:8px"><div style="width:28px;height:28px;border-radius:4px;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg3);font-size:11px">${albumAvatar(a)}</div><div><div style="font-weight:500">${esc(a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(a.artist)}</div></div></div></td>
        ${cell(x.flags.cover)}${cell(x.flags.genre)}${cell(x.flags.note)}${cell(x.flags.tracklist)}
        <td class="mono" style="text-align:right;font-size:12px;color:${x.score === x.max ? 'var(--text3)' : 'var(--amber)'}">${x.score}/${x.max} (${pct}%)</td>
      </tr>`;
    }).join('') || `<tr><td colspan="6"><div class="empty" style="padding:24px"><div class="empty-icon">🧩</div>${hideComplete ? 'Toutes les fiches affichées sont déjà complètes !' : 'Aucun album possédé.'}</div></td></tr>`;
  }

  const moreBtn = document.getElementById('btn-completeness-more');
  if (moreBtn) moreBtn.style.display = list.length > shown.length ? 'inline-block' : 'none';
}

async function scanCoverResolutions() {
  const targets = ownedAlbumsForCovers().filter(a => a.cover_url && !_cache.coverDimsChecked?.has(a.id));
  if (!_cache.lowResCovers) _cache.lowResCovers = new Set();
  if (!_cache.coverDimsChecked) _cache.coverDimsChecked = new Set();
  if (!targets.length) { _cache.lowResScanned = true; toast('Toutes les pochettes ont déjà été scannées'); renderCoversGallery(); return; }

  const progress = document.getElementById('covers-scan-progress');
  progress.style.display = 'block';
  let done = 0;
  const CONCURRENCY = 8;
  let idx = 0;

  function loadOne(a) {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;
      const finish = (lowres) => {
        if (settled) return; // évite un double-appel si le timeout et onload/onerror se chevauchent
        settled = true;
        clearTimeout(timer);
        _cache.coverDimsChecked.add(a.id);
        if (lowres) _cache.lowResCovers.add(a.id);
        resolve();
      };
      // Sécurité : certaines URLs externes (Discogs/Last.fm) ne déclenchent parfois ni onload
      // ni onerror (connexion qui traîne, serveur muet) — sans timeout, ça bloque le worker
      // indéfiniment et, au fil du scan, finit par tout arrêter (les 8 lanes s'y coincent une
      // à une). On traite un timeout comme un échec de chargement, pas comme basse résolution.
      const timer = setTimeout(() => finish(false), 8000);
      img.onload = () => finish(img.naturalWidth > 0 && (img.naturalWidth < COVER_LOWRES_THRESHOLD || img.naturalHeight < COVER_LOWRES_THRESHOLD));
      img.onerror = () => finish(false);
      img.referrerPolicy = 'no-referrer';
      img.src = a.cover_url;
    });
  }

  async function worker() {
    while (idx < targets.length) {
      const a = targets[idx++];
      await loadOne(a);
      done++;
      if (done % 20 === 0 || done === targets.length) {
        progress.textContent = `Scan en cours… ${done}/${targets.length} pochettes vérifiées (${_cache.lowResCovers.size} basse résolution détectée(s))`;
        if (coverFilter === 'lowres') renderCoversGallery();
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  _cache.lowResScanned = true;
  progress.textContent = `Scan terminé : ${_cache.lowResCovers.size} pochette(s) basse résolution sur ${targets.length} vérifiée(s).`;
  toast(`Scan terminé : ${_cache.lowResCovers.size} pochette(s) basse résolution`);
  renderCoversGallery();
}

// ---- Modale de choix de pochette ----
let _coverChoiceAlbumId = null;
let _coverChoiceSelected = '';

function openCoverChoiceModal(sidVal) {
  const id = unsid(sidVal);
  const a = albums.find(x => x.id === id || x.id === String(id));
  if (!a) return;
  _coverChoiceAlbumId = a.id;
  _coverChoiceSelected = a.cover_url || '';
  document.getElementById('cover-choice-sub').textContent = `${a.artist} — ${a.album}`;
  document.getElementById('cover-choice-status').textContent = 'Recherche de propositions…';
  document.getElementById('cover-choice-manual-url').value = '';
  const grid = document.getElementById('cover-choice-grid');
  const candidates = [];
  if (a.cover_url) candidates.push({ url: a.cover_url, label: 'Actuelle' });
  renderCoverChoiceGrid(candidates);
  document.getElementById('modal-cover-choice').classList.add('open');
  fetchCoverCandidates(a).then(extra => {
    extra.forEach(c => { if (!candidates.some(x => x.url === c.url)) candidates.push(c); });
    renderCoverChoiceGrid(candidates);
    document.getElementById('cover-choice-status').textContent = candidates.length
      ? `${candidates.length} proposition(s) trouvée(s).`
      : 'Aucune proposition trouvée automatiquement — colle une URL manuellement ci-dessous.';
  });
}

async function fetchCoverCandidates(a) {
  const out = [];
  // Discogs — URL directe i.discogs.com
  if (a.discogsId) {
    try {
      const data = await callEdgeFn({ source: 'discogs', release_id: a.discogsId });
      if (data.cover_url && !data.cover_url.includes('coverartarchive')) out.push({ url: data.cover_url, label: 'Discogs' });
    } catch(e) { /* ignore */ }
  }
  // Last.fm — direct lastfm.freetls.fastly.net
  try {
    const lfKey = 'e8aae3c9ca05ced8f56443c1108fdc65';
    const rawArtist = (a.artist || '').split(/\s*;\s*/)[0].trim();
    const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(cleanDiscogsArtist(rawArtist))}&album=${encodeURIComponent(a.album)}&api_key=${lfKey}&format=json`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const images = data.album?.image || [];
      const img = images.find(i => i.size === 'extralarge') || images.find(i => i.size === 'large');
      if (img?.['#text'] && !img['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) out.push({ url: img['#text'], label: 'Last.fm' });
    }
  } catch(e) { /* ignore */ }
  return out;
}

function renderCoverChoiceGrid(candidates) {
  const grid = document.getElementById('cover-choice-grid');
  grid.innerHTML = candidates.map(c => `
    <div class="cover-choice-item ${c.url === _coverChoiceSelected ? 'selected' : ''}" onclick="selectCoverCandidate('${esc(c.url).replace(/'/g,"\\'")}', '${esc(c.label).replace(/'/g,"\\'")}')">
      <img src="${esc(c.url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.style.opacity=0.35">
      <div class="src-label">${esc(c.label)}</div>
    </div>`).join('');
}

// label affiché du candidat sélectionné (Discogs/Last.fm/Manuelle/Actuelle) → provenance à l'enregistrement
let _coverChoiceSelectedLabel = '';

function selectCoverCandidate(url, label) {
  _coverChoiceSelected = url;
  _coverChoiceSelectedLabel = label || '';
  document.querySelectorAll('.cover-choice-item').forEach(el => {
    el.classList.toggle('selected', el.querySelector('img')?.src === url);
  });
}

function previewManualCoverUrl() {
  const url = document.getElementById('cover-choice-manual-url').value.trim();
  if (!url) return;
  _coverChoiceSelected = url;
  _coverChoiceSelectedLabel = 'Manuelle';
  const grid = document.getElementById('cover-choice-grid');
  const existing = Array.from(grid.querySelectorAll('.cover-choice-item img')).map(img => ({ url: img.src }));
  renderCoverChoiceGrid([{ url, label: 'Manuelle' }, ...existing.filter(c => c.url !== url).map(c => ({ ...c, label: c.label || '' }))]);
}

async function saveCoverChoice() {
  const a = albums.find(x => x.id === _coverChoiceAlbumId || x.id === String(_coverChoiceAlbumId));
  if (!a) return;
  a.cover_url = _coverChoiceSelected || undefined;
  // Provenance : un choix "Manuelle" verrouille le champ (jamais réécrasé par un
  // enrichissement auto) ; un choix "Discogs"/"Last.fm" reste rafraîchissable ;
  // "Actuelle" (garder la pochette déjà en place) ne modifie pas la provenance existante.
  if (a.cover_url) {
    if (_coverChoiceSelectedLabel === 'Manuelle') setProvenance(a, 'cover_url', 'manual');
    else if (_coverChoiceSelectedLabel === 'Discogs') setProvenance(a, 'cover_url', 'discogs');
    else if (_coverChoiceSelectedLabel === 'Last.fm') setProvenance(a, 'cover_url', 'lastfm');
  } else if (a.field_provenance) {
    delete a.field_provenance.cover_url;
  }
  _cache.coverDimsChecked?.delete(a.id);
  _cache.lowResCovers?.delete(a.id);
  saveToStorage();
  if (window._sb) {
    try { await window._sb.from('albums').update({ cover_url: a.cover_url || null, field_provenance: a.field_provenance || null }).eq('id', a.id); } catch(e) { /* ignore */ }
  }
  document.querySelectorAll(`[data-album-id="${a.id}"]`).forEach(el => { el.innerHTML = albumAvatar(a); });
  invalidateCache();
  updateNavBadges();
  closeCoverChoiceModal();
  renderCoversGallery();
  toast('Pochette mise à jour');
}

function clearCoverChoice() {
  _coverChoiceSelected = '';
  _coverChoiceSelectedLabel = '';
  saveCoverChoice();
}

function closeCoverChoiceModal() {
  document.getElementById('modal-cover-choice').classList.remove('open');
  _coverChoiceAlbumId = null;
  _coverChoiceSelected = '';
}

function closeAlbumModal() { document.getElementById('modal-album').classList.remove('open'); }

function setModalNote(n) {
  _modalNote = n;
  document.querySelectorAll('#modal-stars .modal-star').forEach((s, i) => s.classList.toggle('on', i < n));
}

// Vide les 2 champs prêt dans la modale — ne sauvegarde pas seul, juste avant saveAlbum()
// (comportement volontairement symétrique aux autres champs du formulaire : rien n'est
// persisté tant que "Enregistrer" n'est pas cliqué, pour rester annulable).
function clearLoanFields() {
  document.getElementById('f-loaned-to').value = '';
  document.getElementById('f-loaned-since').value = '';
}

function saveAlbum() {
  const artist = document.getElementById('f-artist').value.trim();
  const album = document.getElementById('f-album').value.trim();
  if (!artist || !album) { toast('Artiste et album requis', 'error'); return; }
  const eid = document.getElementById('edit-id').value;
  const data = {
    artist, album,
    year: document.getElementById('f-year').value.trim(),
    genre: document.getElementById('f-genre').value.trim(),
    cd: document.getElementById('f-cd').checked,
    flac: document.getElementById('f-flac').checked,
    mp3: document.getElementById('f-mp3').checked,
    digital: document.getElementById('f-digital').checked,
    note: _modalNote,
    plays: parseInt(document.getElementById('f-plays').value) || 0,
    notes: document.getElementById('f-notes').value.trim(),
    loaned_to: document.getElementById('f-loaned-to').value.trim() || undefined,
    loaned_since: document.getElementById('f-loaned-since').value || undefined,
    discogsId: document.getElementById('f-discogs-id').value.trim() || undefined,
    cover_url: document.getElementById('f-cover-url')?.value.trim() || undefined,
  };
  if (eid) {
    const idx = albums.findIndex(a => a.id == eid);
    if (idx !== -1) {
      const before = albums[idx];
      // Verrouille en 'manual' (jamais réécrasé par un import/enrichissement auto)
      // tout champ suivi que l'utilisateur a réellement changé depuis cette modale.
      ['year', 'genre', 'cover_url'].forEach(f => {
        if ((data[f] || '') !== (before[f] || '')) setProvenance(data, f, 'manual');
      });
      albums[idx] = { ...before, ...data, field_provenance: { ...before.field_provenance, ...data.field_provenance } };
    }
    toast('Album mis à jour');
  } else {
    ['year', 'genre', 'cover_url'].forEach(f => { if (data[f]) setProvenance(data, f, 'manual'); });
    albums.push({ id: uid(), ...data });
    toast('Album ajouté ✓');
  }
  closeAlbumModal();
  currentPage = 1;
  renderAlbums();
  saveToStorage();
}

// openTrackModal / closeTrackModal / setTrackNote / saveTrack supprimées (v2026.07.10-03)
// avec la modale modal-track — plus aucun bouton n'y mène.

// Close modals on overlay click
['modal-album'].forEach(id => {
  document.getElementById(id).addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
});

// RYM threshold change
document.addEventListener('change', e => {
  if (e.target.id === 'rym-threshold') renderRYM();
});

// ===================== IMPORT: DISCOGS =====================
// Nettoyer les noms d'artistes Discogs : enlever les "(2)", "(3)", etc.
// Discogs ajoute ces suffixes pour distinguer les homonymes
function cleanDiscogsArtist(raw) {
  return (raw || '')
    .replace(/\s*\(\d+\)\s*$/, '')          // enlever (2), (12) en fin de nom
    .replace(/^(.+),\s*The\s*$/i, 'The $1') // "Black Keys, The" → "The Black Keys"
    .replace(/^(.+),\s*A\s*$/i, 'A $1')     // "Band, A" → "A Band"
    // "Various" seul → "Various Artists" pour uniformiser avec MusicBee
    .replace(/^Various$/i, 'Various Artists')
    .trim();
}

async function importDiscogs(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-discogs');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const rows = parseCSV(text);
    let added = 0, updated = 0;
    rows.forEach(row => {
      const artistRaw = row['artist'] || row['artists'] || row['artist name'] || '';
      const artist = cleanDiscogsArtist(artistRaw);
      const album = row['title'] || row['album'] || row['album title'] || '';
      if (!artist || !album) return;
      const fmt = (row['format'] || '').toLowerCase();
      const isCd = fmt.includes('cd') || fmt.includes('vinyl') || fmt.includes('lp');
      const year = row['released'] || row['year'] || row['date'] || '';
      const rating = parseInt(row['rating'] || '0') || 0;
      const discogsId = row['release_id'] || row['discogs_id'] || '';
      const label = row['label'] || '';
      const catno = row['catno'] || '';

      // Appariement par discogsId d'abord (le plus fiable), puis par variantes artiste+album
      let existing = discogsId ? albums.find(a => a.discogsId === discogsId) : null;
      // Alias mémorisés lors de fusions manuelles (ex: réimport CSV sans discogsId)
      if (!existing) {
        const aliasKeyD = normalizeKey(artist, album);
        existing = albums.find(a => (a.mergedAliases || []).some(al => normalizeKey(al.artist, al.album) === aliasKeyD));
      }
     if (!existing) {
        const albumNorm = normalizeKey('', album).replace('|||', '');
        for (const av of artistVariants(artist)) {
          const candidate = albums.find(a => normalizeKey(a.artist, a.album) === av + '|||' + albumNorm
            || normalizeKey(cleanDiscogsArtist(a.artist), a.album) === av + '|||' + albumNorm);
          // Ne pas fusionner si l'entrée trouvée a un discogsId différent (albums homonymes)
          if (candidate && discogsId && candidate.discogsId && candidate.discogsId !== discogsId) continue;
          if (candidate) { existing = candidate; break; }
        }
        // Fallback clé standard — même vérification
        if (!existing) {
          const candidate = albums.find(a => normalizeKey(a.artist, a.album) === normalizeKey(artist, album));
          if (candidate && discogsId && candidate.discogsId && candidate.discogsId !== discogsId) {
            // Albums homonymes avec discogsIds différents → laisser existing = null pour créer
          } else {
            existing = candidate;
          }
        }
      }

      // Pour les albums homonymes (même normalizeKey, discogsId différent), utiliser un ID avec suffixe.
      // IMPORTANT : une "collision" n'est réelle que si l'entrée existante a déjà un discogsId différent.
      // Si elle n'a pas de discogsId, c'est le même album (numérique sans CD) → on fusionne, pas de suffixe.
      const baseKey = normalizeKey(artist, album);
      const trueCollision = discogsId && !existing && albums.some(a =>
        normalizeKey(a.artist, a.album) === baseKey && a.discogsId && a.discogsId !== discogsId
      );

      if (existing) {
        if (isCd) existing.cd = true;
        if (rating) existing.discogsRating = Math.min(5, rating);
        // Toujours réécrire l'année depuis le CSV Discogs (source faisant autorité pour un
        // discogsId donné) — sans ça, une année stockée par erreur (ex: héritée d'une
        // fusion homonyme incorrecte) ne pouvait jamais être corrigée par un réimport,
        // contrairement à l'import MusicBee XML qui, lui, réécrit toujours depuis le tag.
        if (year) { existing.year = year.slice(0, 4); setProvenance(existing, 'year', 'discogs'); }
        if (discogsId && !existing.discogsId) {
          existing.discogsId = discogsId;
          // Si d'autres albums ont le même normalizeKey, s'assurer que cet existing a un ID unique
          const hasHomonym = albums.some(a => a !== existing && normalizeKey(a.artist, a.album) === baseKey && a.discogsId && a.discogsId !== discogsId);
          if (hasHomonym && existing.id === baseKey) {
            existing.id = baseKey + '|||dc:' + discogsId;
          }
        }
        if (label && !existing.label && !isManualField(existing, 'label')) { existing.label = label; setProvenance(existing, 'label', 'discogs'); }
        if (catno && !existing.catno) existing.catno = catno;
        if (existing.artist !== artist && cleanDiscogsArtist(existing.artist) === cleanDiscogsArtist(existing.artist)) {
          existing.artistRaw = artistRaw;
        }
        updated++;
      } else {
        const newId = trueCollision ? baseKey + '|||dc:' + discogsId : baseKey;
        const newAlbum = {
          id: newId, artist, artistRaw, album,
          year: year.slice(0, 4), genre: '',
          cd: isCd, flac: false, mp3: false, digital: false,
          note: 0, discogsRating: Math.min(5, rating) || 0, plays: 0,
          discogsId, label, catno
        };
        if (year) setProvenance(newAlbum, 'year', 'discogs');
        if (label) setProvenance(newAlbum, 'label', 'discogs');
        albums.push(newAlbum);
        added++;
      }
    });
    invalidateCache();
    status.textContent = `✓ ${added} ajoutés, ${updated} mis à jour`;
    status.className = 'status ok';
    renderAlbums();
    toast(`Discogs : ${added} ajoutés, ${updated} mis à jour`);
    saveToStorage();
    updateNavBadges();
    // Charger les tracklists Discogs manquantes en arrière-plan
    setTimeout(() => fetchAllTracklists(true), 1500);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}

// ===================== IMPORT: MUSICBEE XML (iTunes format) =====================
async function importMusicBeeXML(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-musicbee');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');

    // Vérifier que le XML est valide
    if (doc.querySelector('parsererror')) throw new Error('Fichier XML invalide');

    // Le format iTunes XML : <dict><key>Tracks</key><dict> contenant <key>ID</key><dict>...</dict>
    // On cherche le dict enfant du key "Tracks"
    const rootDict = doc.querySelector('plist > dict');
    if (!rootDict) throw new Error('Structure plist introuvable');

    // Trouver le dict des tracks : la key "Tracks" est suivie d'un dict
    const tracksDict = getKeyValue(rootDict, 'Tracks');
    if (!tracksDict || tracksDict.tagName !== 'dict') throw new Error('Section Tracks introuvable');

    // Parser chaque piste : les enfants alternent <key>ID</key><dict>...</dict>
    const trackDicts = [];
    const children = Array.from(tracksDict.children);
    for (let i = 0; i < children.length - 1; i += 2) {
      if (children[i].tagName === 'key' && children[i+1].tagName === 'dict') {
        trackDicts.push(children[i+1]);
      }
    }

    // Helper : lire une valeur depuis un dict iTunes par sa key
    function getVal(dict, key) {
      const kids = Array.from(dict.children);
      for (let i = 0; i < kids.length - 1; i++) {
        if (kids[i].tagName === 'key' && kids[i].textContent === key) {
          return kids[i+1];
        }
      }
      return null;
    }
    function str(dict, key) { const n = getVal(dict, key); return n ? n.textContent.trim() : ''; }
    function num(dict, key) { const n = getVal(dict, key); return n ? parseInt(n.textContent) || 0 : 0; }
    function dateStr(dict, key) { const n = getVal(dict, key); return n ? n.textContent.trim().slice(0,10) : ''; }
    function bool(dict, key) { const n = getVal(dict, key); return n ? n.tagName.toLowerCase() === 'true' : false; }
    function extractYear(val) { if (!val) return ''; const m = String(val).match(/^(\d{4})/); return m ? m[1] : ''; }

    // Convertir la note iTunes/MusicBee : 0-100 → 0-5 étoiles
    // MusicBee : 20=1★, 40=2★, 60=3★, 80=4★, 100=5★
   function parseRating(r) {
      if (!r) return 0;
      if (r <= 5) return r;                  // déjà en étoiles
      return Math.round(r / 2) / 10;         // % → étoiles avec décimales (ex: 90 → 4.5)
    }

    // Détecter le format depuis Kind ou Location
    function detectFormat(kind, location) {
      const k = (kind + location).toLowerCase();
      if (k.includes('flac')) return { flac: true, mp3: false };
      if (k.includes('mpeg') || k.includes('mp3')) return { flac: false, mp3: true };
      return { flac: false, mp3: false };
    }

  // Détecter le dossier spécial depuis le chemin
    function detectFolder(location) {
      const p = decodeURIComponent(location).toLowerCase().replace(/\\/g, '/');
      if (p.includes('!_00_stock')) return 'stock';
      if (p.includes('top titres') || p.includes('top-titres') || p.includes('top_titres')) return 'isolated';
      if (p.includes('blind-test') || p.includes('blind_test')) return 'ignore';
      const seg = p.split('/');
      if (seg.some(s => s === 'ok' || s === 'ok ')) return 'ok';
      if (seg.some(s => s === '!vendre' || s === 'a_vendre' || s === 'a vendre' || s === '!a vendre')) return 'vendre';
      if (seg.some(s => s === 'discographie')) return 'discographie';
      return 'album';
    }

    // Grouper par album
    const grouped = {};       // albums normaux
    const isolatedTracks = []; // morceaux isolés
    const stockAlbums = [];    // stock
    const importedTrackKeys = new Set(); // clés artiste|||titre de tous les morceaux du XML (pour matcher la wishlist morceaux)

    trackDicts.forEach(d => {
      const name        = str(d, 'Name');
      const artist      = str(d, 'Artist');
      const albumArtist = str(d, 'Album Artist');
      const album       = str(d, 'Album');
      // Year peut être "1997-08-26" (Picard) ou "1997" — extraire l'année sur 4 chiffres
      const yearRaw     = str(d, 'Year') || str(d, 'Original Year') || String(num(d, 'Year') || '');
      const year        = extractYear(yearRaw);
      const releaseDate = yearRaw.length > 4 ? yearRaw.slice(0, 10) : '';
      const genre       = str(d, 'Genre');
      const rating      = parseRating(num(d, 'Rating'));
      const kind        = str(d, 'Kind');
      const location    = str(d, 'Location');
      const { flac, mp3 } = detectFormat(kind, location);
      const folder      = detectFolder(location);
		
		
	
		
      // Champs Picard MusicBrainz
      const mbidAlbum  = str(d, 'MusicBrainz Album Id')
                      || str(d, 'MBID Album')
                      || str(d, 'MUSICBRAINZ_ALBUMID')
                      || str(d, 'MusicBrainz Release Id')
                      || str(d, 'MusicBrainz Release Group Id');
      const mbidArtist = str(d, 'MusicBrainz Artist Id')
                      || str(d, 'MBID Artiste')
                      || str(d, 'MUSICBRAINZ_ARTISTID');
      const isCompilTag = bool(d, 'Compilation');
      const composer   = str(d, 'Composer');
      const discNum    = num(d, 'Disc Number') || 1;
      const discCnt    = num(d, 'Disc Count')  || 1;
      const trkCnt     = num(d, 'Track Count') || 0;

      // Artiste effectif : préférer Album Artist
      // Pour les compilations (Various Artists), garder "Various Artists" comme artiste de l'album
      const isCompilation = isCompilTag || albumArtist === 'Various Artists';
      const effectiveArtist = isCompilation ? 'Various Artists' : (albumArtist || artist);

	if (folder === 'ignore') return;

      // Alimente l'ensemble des morceaux possédés (matching wishlist morceaux)
      if (name) {
        if (artist) importedTrackKeys.add(normalizeKey(artist, name));
        if (effectiveArtist && effectiveArtist !== artist) importedTrackKeys.add(normalizeKey(effectiveArtist, name));
      }

      if (folder === 'stock') {
        // Structure : !_00_stock/YYYY/Artist - Album (Date)/Artist - NN - Track.flac
        // Les métadonnées MusicBee sont prioritaires (Picard les renseigne bien)

        // Artiste et album depuis métadonnées si disponibles
        let stockArtist = (effectiveArtist && effectiveArtist.trim() && !effectiveArtist.includes('/')) ? cleanDiscogsArtist(effectiveArtist) : '';
        let stockAlbum  = (album && album.trim() && !album.includes('/')) ? album : '';

        // Fallback : parser depuis le chemin si métadonnées vides
        if (!stockArtist || !stockAlbum) {
          const pathParts = decodeURIComponent(location).replace(/\\/g, '/').split('/');
          const stockIdx = pathParts.findIndex(p => p.toLowerCase().includes('stock'));
          // Ignorer les segments qui sont juste une année (ex: "2026")
          const afterStock = pathParts.slice(stockIdx + 1).filter(p => p && !/^\d{4}$/.test(p));
          // afterStock[0] = "Artist - Album (Date)" ou "Artist"
          // afterStock[1] = "Artist - Album" ou fichier
          if (afterStock.length >= 1) {
            const seg = afterStock[0]; // ex: "Em Spel - Bird or Snake (2026-04-03)"
            // Format "Artist - Album (Date)"
            const m = seg.match(/^(.+?)\s+-\s+(.+?)(?:\s*\([\.\d-]+\))?$/);
            if (m) {
              if (!stockArtist) stockArtist = cleanDiscogsArtist(m[1].trim());
              if (!stockAlbum)  stockAlbum  = m[2].trim();
            } else {
              // Pas de " - " : tout le segment = album si artiste connu, sinon artiste
              if (!stockAlbum && afterStock.length >= 2) {
                if (!stockArtist) stockArtist = seg;
                if (!stockAlbum)  stockAlbum  = afterStock[1];
              } else if (!stockAlbum) {
                stockAlbum = seg;
              }
            }
          }
        }

        // Extraire année depuis métadonnées ou nom de dossier
        let stockYear = year.slice(0,4);
        if (!stockYear) {
          // Chercher dans le chemin : segment /YYYY/ ou "(YYYY"
          const pathLow = decodeURIComponent(location).replace(/\\/g, '/');
          const ym1 = pathLow.match(/\/?(\d{4})\//);  // segment année
          const ym2 = stockAlbum?.match(/\((\d{4})/);  // "(2026" dans le nom
          stockYear = ym1?.[1] || ym2?.[1] || '';
        }

        // Nettoyer l'album (retirer date/année entre parenthèses et extension)
        if (stockAlbum) {
          stockAlbum = stockAlbum
            .replace(/\s*\([\d-]{4,10}\)\s*$/, '') // "(2026-04-03)" ou "(2026)"
            .replace(/\.[a-z0-9]{2,5}$/i, '')         // extension si fichier
            .trim();
        }

        const stockGenre = genre || '';
        if (!stockArtist && !stockAlbum) return;
        const key = normalizeKey(stockArtist, stockAlbum);
        if (!stockAlbums.find(s => normalizeKey(s.artist, s.album) === key)) {
          stockAlbums.push({ artist: stockArtist, album: stockAlbum, year: stockYear, genre: stockGenre, format: flac ? 'flac' : mp3 ? 'mp3' : 'autre' });
        }
        // Les pistes stock sont collectées par importMusicBeeTracklists (tous dossiers)
      } else if (folder === 'isolated') {
        if (!name) return;
        let trackArtist = artist;
        let trackTitle  = name;

        // Artistes "génériques" MusicBee : tag vide, "music", "unknown", chemin, etc.
        const GENERIC_ARTISTS = new Set(['music', 'unknown', 'unknown artist', 'artiste inconnu', '']);
        const artistIsGeneric = !trackArtist
          || trackArtist.includes('\\') || trackArtist.includes('/')
          || /^[A-Z]:\\/.test(trackArtist)
          || GENERIC_ARTISTS.has(trackArtist.toLowerCase().trim());

        if (artistIsGeneric) {
          // 1. Essayer de parser "Artiste - Titre" depuis Name (avec date ISO optionnelle)
          //    ex: "Laura Veirs - Autumn Song (2022-07-08)" ou "Laura Veirs - Autumn Song"
          const mName = name.match(/^(.+?)\s+[-–]\s+(.+?)(?:\s*\(\d{4}(?:-\d{2}-\d{2})?\))?$/);
          if (mName) {
            trackArtist = mName[1].trim();
            trackTitle  = mName[2].trim();
          } else {
            // 2. Fallback : chemin .../top titres/Artiste/fichier
            const pathParts = decodeURIComponent(location).replace(/\\/g, '/').split('/');
            const topIdx = pathParts.findIndex(p => /top.?ti/i.test(p));
            if (topIdx >= 0 && pathParts[topIdx + 1]) {
              trackArtist = pathParts[topIdx + 1];
            }
          }
        }

        // Nettoyer date ISO en fin de titre : "(2022-07-08)" ou "(2022)"
        trackTitle = trackTitle
          .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')
          .replace(/\s*\(\d{4}\)\s*$/, '')
          .trim();
        // Nettoyer artiste style Discogs "(N)"
        trackArtist = cleanDiscogsArtist(trackArtist);

        if (!trackTitle) return;
             const mbRecordingId = str(d, 'MusicBrainz Recording Id')
                         || str(d, 'MusicBrainz Track Id')
                         || str(d, 'MBID Track')
                         || str(d, 'MUSICBRAINZ_TRACKID')
                         || null;
        isolatedTracks.push({
          title: trackTitle, artist: trackArtist, album,
          format: flac ? 'flac' : mp3 ? 'mp3' : 'autre',
          rating, mbRecordingId,
          bitrate: num(d, 'Bit Rate') || null,
          playCount: num(d, 'Play Count') || null,
        });
      } else {
        // Album normal
        if (!album) return;
        // Clé de groupement : si un MBID Album est disponible, l'utiliser comme discriminant
        // pour séparer les albums homonymes (ex: Weezer Blue 1994 vs Green 2001, tous deux "Weezer").
        // Sans MBID, fallback sur normalizeKey seul (comportement historique).
        const baseKey = normalizeKey(effectiveArtist, album);
        const key = mbidAlbum ? baseKey + '|||mbid:' + mbidAlbum : baseKey;
        const albumRating = parseRating(num(d, 'Album Rating'));
		if (!grouped[key]) {
		grouped[key] = { artist: effectiveArtist, album, year: year.slice(0,4), genre,
			flac: false, mp3: false, digital: false, albumRating: 0,
			isCompilation, trackArtists: [],
			okFolder: false, forSaleFolder: false, discoFolder: false,
			primaryFolder: folder === 'discographie' ? 'discographie'
                 : folder === 'ok'           ? 'ok'
                 : folder === 'vendre'       ? 'forsale'
                 : 'album',
			mbReleaseId: mbidAlbum || '',
			releaseDate:  releaseDate || '' };
		}
	if (folder === 'ok')           grouped[key].okFolder     = true;
	if (folder === 'vendre')       grouped[key].forSaleFolder = true;
	if (folder === 'discographie') grouped[key].discoFolder   = true;
	// Upgrade primaryFolder si une piste est dans un dossier plus "noble"
	const pf = grouped[key].primaryFolder;
	if (folder === 'discographie' && pf === 'album') grouped[key].primaryFolder = 'discographie';
	if (folder === 'ok')                             grouped[key].primaryFolder = 'ok';
	if (folder === 'vendre')                         grouped[key].primaryFolder = 'forsale';
        // Enrichir si données manquantes
        if (mbidAlbum  && !grouped[key].mbReleaseId)  grouped[key].mbReleaseId  = mbidAlbum;
        if (releaseDate && !grouped[key].releaseDate) grouped[key].releaseDate  = releaseDate;
        if (flac) grouped[key].flac = true;
        else if (mp3) grouped[key].mp3 = true;
        else grouped[key].digital = true;
        if (!grouped[key].year && year) grouped[key].year = year.slice(0,4);
        if (!grouped[key].genre && genre) grouped[key].genre = genre;
        // Prend directement le tag "Album Rating" tel qu'exporté par MusicBee — un seul, le
        // 1er non nul rencontré (les pistes suivantes du même album n'écrasent plus rien).
        // Avant (v2026.07.12-13) : agrégation par fréquence (valeur la plus fréquente parmi
        // les tags des pistes, pour absorber un tag isolé désynchronisé) — trop indirect
        // (l'album affiché n'était pas forcément CE que MusicBee affiche comme Album Rating)
        // et le départage en cas d'égalité de fréquence n'était pas prévisible. Simplifié à la
        // demande d'Antoine : "Album Rating" est déjà censé être identique sur toutes les
        // pistes d'un même album côté MusicBee quand il est correctement synchronisé — inutile
        // de recalculer, autant prendre directement la valeur telle quelle.
        if (albumRating && !grouped[key].albumRating) {
          grouped[key].albumRating = albumRating;
        }
        // Pour les compilations : collecter les artistes individuels (Array, pas de doublon)
        if (isCompilation && artist && artist !== 'Various Artists') {
          if (!Array.isArray(grouped[key].trackArtists)) grouped[key].trackArtists = [];
          if (!grouped[key].trackArtists.includes(artist)) grouped[key].trackArtists.push(artist);
        }
      }
    });

    // ── Albums numériques : merge (on ne supprime pas les CDs Discogs) ──
    // Construire d'abord l'index des clés présentes dans le XML courant
    // pour ne réinitialiser les flags QUE sur les albums effectivement retrouvés.
    // Un reset global effacerait les flags des albums dont le nom a légèrement changé
    // ou qui se trouvent dans !_00_stock (stockItems) — ils ne seraient jamais restaurés.
    const xmlGroupKeys = new Set();
    Object.values(grouped).forEach(g => {
      if (!g.artist && !g.album) return;
      const albumNorm = normalizeKey('', g.album).replace('|||', '');
      xmlGroupKeys.add(normalizeKey(g.artist, g.album));
      for (const av of artistVariants(g.artist)) xmlGroupKeys.add(av + '|||' + albumNorm);
    });
    // Reset ciblé : seulement les albums dont on va recalculer les flags depuis le XML
    albums.forEach(a => {
      if (a.cd) return; // les CDs Discogs ne touchent jamais leurs flags ici
      const albumNorm = normalizeKey('', a.album).replace('|||', '');
      const hits = [normalizeKey(a.artist, a.album), ...Array.from(artistVariants(a.artist)).map(av => av + '|||' + albumNorm)];
      if (hits.some(k => xmlGroupKeys.has(k))) {
        a.flac = false; a.mp3 = false; a.digital = false;
      }
    });

    // Pré-indexer albums par clés exactes pour O(1) lookup
    // On n'utilise PAS artistVariants ici — trop de faux positifs (clés "volées")
    const albumByVariantKey = new Map();
    albums.forEach(a => {
      // MBID en premier : discriminant parfait pour les homonymes (Weezer Blue vs Green)
      // On écrase volontairement si un autre album a le même MBID (ne devrait pas arriver)
      if (a.mb_release_id) albumByVariantKey.set('mbid:' + a.mb_release_id, a);
      // ID stable
      if (!albumByVariantKey.has(a.id)) albumByVariantKey.set(a.id, a);
      // normalizeKey exact — ne pas écraser une entrée déjà indexée par MBID ou id
      const exactKey = normalizeKey(a.artist, a.album);
      if (!albumByVariantKey.has(exactKey)) albumByVariantKey.set(exactKey, a);
      // Discogs nettoyé
      const cleanKey = normalizeKey(cleanDiscogsArtist(a.artist), a.album);
      if (!albumByVariantKey.has(cleanKey)) albumByVariantKey.set(cleanKey, a);
      // Sans The/A
      const noTheKey = normalizeKey((a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'').trim(), a.album);
      if (!albumByVariantKey.has(noTheKey)) albumByVariantKey.set(noTheKey, a);
      // Various/Various Artists
      const normArt = normalizeKey(a.artist,'').replace('|||','');
      if (normArt === 'various' || normArt === 'various artists') {
        ['various', 'various artists'].forEach(v => {
          const k = v + '|||' + normalizeKey('', a.album).replace('|||','');
          if (!albumByVariantKey.has(k)) albumByVariantKey.set(k, a);
        });
      }
      // Alias mémorisés lors de fusions manuelles (fiches CD/numérique fusionnées dont
      // l'artiste/album ne matche aucune des variantes ci-dessus, ex: nom Discogs vs tag MusicBee)
      (a.mergedAliases || []).forEach(al => {
        const aliasKey = normalizeKey(al.artist, al.album);
        if (!albumByVariantKey.has(aliasKey)) albumByVariantKey.set(aliasKey, a);
      });
    });
	let albumsAdded = 0, albumsUpdated = 0;
    // Trace les albums confirmés présents dans CET export XML — sert après la boucle à
    // détecter les albums qui avaient 'ok'/'discographie' lors d'un import précédent mais qui
    // ont disparu de l'export courant (retagués hors scope, déplacés, etc. — cf. fix ci-dessous).
    const touchedAlbumIds = new Set();
	Object.values(grouped).forEach(g => {
      if (!g.artist && !g.album) return;
      // Lookup par clés exactes (mêmes que l'index)
      const gExact   = normalizeKey(g.artist, g.album);
      const gClean   = normalizeKey(cleanDiscogsArtist(g.artist), g.album);
      const gNoThe   = normalizeKey((g.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'').trim(), g.album);
      const gId      = stableAlbumId(g.artist, g.album, g.mbReleaseId);

      // Valider le match : l'album trouvé doit avoir la même clé normalisée album
      // pour éviter les faux positifs (ex: variante noThe d'un artiste différent)
      const gAlbumNorm = normalizeKey('', g.album).replace('|||', '');
      const isValidMatch = (a) => {
        if (!a) return false;
        const aAlbumNorm = normalizeKey('', a.album).replace('|||', '');
        return aAlbumNorm === gAlbumNorm;
      };

      let existing = null;
      // Priorité 1 : MBID Album (discriminant parfait pour les homonymes)
      // GARDE-FOUS :
      // a) Si l'entrée trouvée a déjà un mb_release_id DIFFÉRENT → MBID croisé → ignorer
      // b) Si l'entrée n'a pas de mb_release_id mais une année différente ET qu'un autre
      //    homonyme existe → probable état corrompu → laisser la Priorité 3 (allHomonyms+année) décider
      if (g.mbReleaseId) {
        const byMbid = albumByVariantKey.get('mbid:' + g.mbReleaseId);
        if (byMbid) {
          const mbOk = !byMbid.mb_release_id || byMbid.mb_release_id === g.mbReleaseId;
          const yearOk = !g.year || !byMbid.year || byMbid.year.slice(0,4) === g.year.slice(0,4);
          // N'accepter que si MBID correct ET (année compatible OU pas d'autre candidat homonyme)
          const hasOtherHomonym = albums.some(a => a !== byMbid && isValidMatch(a));
          if (mbOk && (yearOk || !hasOtherHomonym)) {
            existing = byMbid;
          }
        }
      }
      // Priorité 2 : ID stable (inclut déjà le MBID dans stableAlbumId)
      if (!existing) {
        const byId = albumByVariantKey.get(gId);
        if (byId && isValidMatch(byId)) existing = byId;
      }
      if (!existing) {
        // Collecter TOUS les albums homonymes (pas juste le premier dans l'index)
        // albumByVariantKey ne garde que le premier par clé texte → albums homonymes invisibles
        const allHomonyms = albums.filter(a => isValidMatch(a) && (
          normalizeKey(a.artist, a.album) === gExact ||
          normalizeKey(cleanDiscogsArtist(a.artist), a.album) === gClean ||
          normalizeKey((a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'').trim(), a.album) === gNoThe
        ));
        // Various Artists ↔ Various
        const normArt = normalizeKey(g.artist,'').replace('|||','');
        if (normArt === 'various' || normArt === 'various artists') {
          albums.forEach(a => {
            const an = normalizeKey(a.artist,'').replace('|||','');
            if ((an === 'various' || an === 'various artists') && isValidMatch(a) && !allHomonyms.includes(a))
              allHomonyms.push(a);
          });
        }
        // Filtrer : si MBID XML présent, exclure les candidats qui ont un MBID différent
        const validCandidates = [...new Set(allHomonyms)].filter(a => {
          if (!g.mbReleaseId) return true;
          if (!a.mb_release_id) return true; // pas encore de MBID → candidat valide, on le prendra par année
          return a.mb_release_id === g.mbReleaseId;
        });
        // LOG diagnostic homonymes
        if (validCandidates.length > 1) {
          console.log(`[homonyme] "${g.artist} — ${g.album}" (${g.year}) MBID=${g.mbReleaseId||'none'} → ${validCandidates.length} candidats:`, validCandidates.map(a => `${a.year} id=${a.id} mb=${a.mb_release_id||'none'}`));
        }
        // Départager par année si plusieurs candidats
        if (validCandidates.length > 1 && g.year) {
          const byYear = validCandidates.find(a => a.year && a.year.slice(0,4) === g.year.slice(0,4));
          if (byYear) existing = byYear;
        }
        // Si un seul candidat, aucune ambiguïté : on le prend. S'il en reste plusieurs et
        // qu'aucun n'a pu être départagé par année, NE PAS deviner arbitrairement (l'ancien
        // comportement prenait validCandidates[0] au hasard, ce qui pouvait écraser
        // silencieusement l'année/les données d'un homonyme complètement différent — c'est
        // exactement ce qui a corrompu l'année de "Weezer — Weezer" Green Album). Mieux vaut
        // créer une nouvelle fiche (visible, fusionnable manuellement) qu'une corruption
        // silencieuse invisible.
        if (!existing) {
          if (validCandidates.length === 1) existing = validCandidates[0];
          else if (validCandidates.length > 1) {
            console.log(`[homonyme] "${g.artist} — ${g.album}" (${g.year}) → ambigu, ${validCandidates.length} candidats non désambiguïsés par année — nouvelle fiche créée plutôt qu'un choix arbitraire`);
          }
        }
      }
      const newFolders = [];
      if (g.okFolder)      newFolders.push('ok');
      if (g.forSaleFolder) newFolders.push('forsale');
      if (g.discoFolder)   newFolders.push('discographie');
      if (!g.okFolder && !g.forSaleFolder && !g.discoFolder) newFolders.push('album');

      // Format depuis le XML
      const fmt = g.flac ? 'flac' : g.mp3 ? 'mp3' : g.digital ? 'digital' : null;

      if (existing) {
        touchedAlbumIds.add(existing.id);
        // Mettre à jour toujours depuis XML
        if (g.year)  { existing.year  = g.year;  setProvenance(existing, 'year',  'musicbee'); }
        // Genre : respecte désormais le verrou manuel (v2026.07.12-14, demandé par Antoine) —
        // jusqu'ici MusicBee écrasait le genre sans condition même verrouillé (seule exception
        // au principe "un champ verrouillé n'est plus jamais écrasé"), ce qui annulait
        // silencieusement les fusions du Nettoyage des genres au réimport suivant tant que le
        // tag MusicBee lui-même n'était pas corrigé — impossible pour Antoine, qui n'est pas
        // maître de la donnée MusicBee/Discogs (synchros avec leurs propres BDD).
        if (g.genre && !isManualField(existing, 'genre')) { existing.genre = g.genre; setProvenance(existing, 'genre', 'musicbee'); }
        const newNote = g.albumRating;
        if (newNote) existing.note = newNote;
        if (fmt) existing.format = fmt;
        // Mettre à jour compat flags
        existing.flac    = existing.format === 'flac';
        existing.mp3     = existing.format === 'mp3';
        existing.digital = existing.format === 'digital';
        // Normaliser artiste — respecte le verrou manuel (même raison que le genre ci-dessus),
        // en plus de la protection déjà existante pour les albums avec discogsId.
        if (g.artist && normalizeKey(g.artist, '') !== normalizeKey(existing.artist, '')) {
          if (!existing.discogsId && !isManualField(existing, 'artist')) existing.artist = g.artist;
        }
        // Folders : 'ok' et 'discographie' sont purement dérivés du chemin physique du
        // fichier dans le XML courant (pas de flag manuel équivalent à forSale) — on les
        // retire avant de les réappliquer, sinon un album resterait bloqué dans 'ok' après
        // avoir été déplacé sur le disque vers Discographie (folders[] ne faisait qu'ajouter).
        if (!existing.folders) existing.folders = [];
        existing.folders = existing.folders.filter(f => f !== 'ok' && f !== 'discographie');
        newFolders.forEach(f => { if (!existing.folders.includes(f)) existing.folders.push(f); });
		existing.okFolder = existing.folders.includes('ok');
        // Ne pas écraser forSale s'il a été positionné manuellement
        // (markForSale met forSale=true mais n'écrit pas dans folders[])
        // On synchronise folders[] ↔ forSale dans les deux sens
        if (existing.folders.includes('forsale')) {
          existing.forSale = true;
        }
        // Si forSale était true avant l'import et que le dossier n'est pas dans XML,
        // conserver le flag ET l'écrire dans folders[] pour la prochaine fois
        if (existing.forSale && !existing.folders.includes('forsale')) {
          existing.folders.push('forsale');
        }
        existing.isCompilation = g.isCompilation || existing.isCompilation;
		if (g.mbReleaseId !== (existing.mb_release_id || '')) {
          if (g.mbReleaseId) {
            existing.mb_release_id = g.mbReleaseId;
            // Passer le discogsId existant pour préserver le suffixe |||dc: des homonymes
            const newId = stableAlbumId(existing.artist, existing.album, g.mbReleaseId, existing.discogsId);
            if (newId !== existing.id) existing.id = newId;
          } else {
            existing.mb_release_id = undefined;
          }
        }
        albumsUpdated++;
      } else {
        // Si un homonyme existe déjà sous l'id de base (cas ambigu ci-dessus, aucune
        // association fiable trouvée), il faut un id distinct pour ne pas écraser cet autre
        // album au push — utiliser le MBID comme suffixe si disponible.
        const baseId = stableAlbumId(g.artist, g.album, g.mbReleaseId);
        const idCollision = albums.some(a => a.id === baseId);
        const newId = (idCollision && g.mbReleaseId) ? baseId + '|||mb:' + g.mbReleaseId : baseId;
        const newAlbum = {
          id:            newId,
          artist:        g.artist,
          album:         g.album,
          year:          g.year,
          genre:         g.genre,
          folders:       newFolders,
          has_cd:        false,
          format:        fmt,
          note:          g.albumRating || 0,
          plays:         0,
		  primaryFolder: g.primaryFolder || 'album',
          isCompilation: g.isCompilation || false,
          mb_release_id: g.mbReleaseId || undefined,
          // compat
          cd: false, flac: fmt==='flac', mp3: fmt==='mp3', digital: fmt==='digital',
          okFolder: newFolders.includes('ok'), forSale: newFolders.includes('forsale'),
        };
        albums.push(newAlbum);
        touchedAlbumIds.add(newAlbum.id);
        albumsAdded++;
      }
    });

    // ── Nettoyage des orphelins 'ok'/'discographie' ──────────────────────────────────────
    // 'ok' et 'discographie' sont purement dérivés du chemin physique du fichier dans l'export
    // XML COURANT (comme rappelé plus haut pour les albums matchés) — mais jusqu'ici, un album
    // absent de cet export (retagué hors scope, déplacé, supprimé du disque…) gardait pour
    // toujours son statut du dernier import où il apparaissait. Signalé par Antoine : 2
    // audiobooks retagués restaient marqués "✅ Ok" après réimport alors qu'ils n'y sont plus.
    // Ne touche jamais 'forsale' (volontairement persistant, cf. plus haut) ni 'stock'
    // (réconcilié séparément juste en dessous, via stockAlbums) — uniquement les albums ayant
    // 'ok'/'discographie' et qu'AUCUNE entrée de cet export n'a confirmés présents.
    let orphansCleaned = 0;
    albums.forEach(a => {
      if (touchedAlbumIds.has(a.id)) return;
      if (!a.folders || (!a.folders.includes('ok') && !a.folders.includes('discographie'))) return;
      a.folders = a.folders.filter(f => f !== 'ok' && f !== 'discographie');
      if (!a.folders.length) a.folders.push('album');
      a.okFolder = false;
      orphansCleaned++;
    });
    if (orphansCleaned) console.log(`[XML import] ${orphansCleaned} album(s) retiré(s) de Ok/Discographie (absents de cet export)`);

    // ── Morceaux isolés : REMPLACEMENT COMPLET depuis MusicBee ──
    const existingTrackNotes = {};
    tracks.forEach(t => { existingTrackNotes[normalizeKey(t.artist, t.title)] = t.note || 0; });
    tracks = isolatedTracks
      .filter(t => t.title && t.artist)
      .map(t => {
        const an = normalizeKey(t.artist, '').replace('|||', '');
        const tn = normalizeKey('', t.title).replace('|||', '');
        return {
          id: an + '|||' + tn,
          artistNorm: an, titleNorm: tn,
          title: t.title, artist: t.artist, album: t.album,
          format: t.format, duration: '',
          note: existingTrackNotes[normalizeKey(t.artist, t.title)] || t.rating || 0,
          mb_recording_id: t.mbRecordingId || undefined,
          bitrate: t.bitrate || undefined,
        };
      });

    // ── Stock : mettre à jour folders dans albums[] ──
    // Les albums stock sont dans grouped (si folder=album) ou stockAlbums (si folder=stock)
    // On ne retire plus les stock de albums[] — on met juste à jour leurs folders
    const existingStockMeta = {};
    albums.filter(a => a.folders?.includes('stock')).forEach(a => {
      existingStockMeta[normalizeKey(a.artist, a.album)] = { note: a.note || 0, notes: a.notes || '' };
    });
    // Retirer le flag 'stock' des albums existants (sera recalculé depuis XML)
    albums.forEach(a => {
      if (a.folders) a.folders = a.folders.filter(f => f !== 'stock');
    });
    // Réintégrer depuis XML stockAlbums
    stockAlbums.forEach(s => {
      const k = normalizeKey(s.artist, s.album);
      const albumNorm = normalizeKey('', s.album).replace('|||', '');
      const meta = existingStockMeta[k] || { note: 0, notes: '' };
      // Chercher dans albums[] — plusieurs stratégies pour éviter les doublons
      let ex = albums.find(a => a.id === k || a.id === stableAlbumId(s.artist, s.album, null));
      if (!ex) {
        for (const av of artistVariants(s.artist)) {
          ex = albums.find(a => a.id === av + '|||' + albumNorm);
          if (ex) break;
        }
      }
      // Fallback : normalizeKey direct (couvre les variantes &/and, casse, etc.)
      if (!ex) {
        ex = albums.find(a => normalizeKey(a.artist, a.album) === k);
      }
      if (ex) {
        if (!ex.folders) ex.folders = [];
        if (!ex.folders.includes('stock')) ex.folders.push('stock');
        if (meta.note && !ex.note) ex.note = meta.note;
        if (meta.notes && !ex.notes) ex.notes = meta.notes;
      } else {
        const newId = stableAlbumId(s.artist, s.album, null);
        // Vérifier qu'aucun album avec ce normalizeKey n'existe déjà sous un id différent
        // (peut arriver si &→and crée une clé légèrement différente)
        const dupCheck = albums.find(a => normalizeKey(a.artist, a.album) === k);
        if (dupCheck) {
          if (!dupCheck.folders) dupCheck.folders = [];
          if (!dupCheck.folders.includes('stock')) dupCheck.folders.push('stock');
          if (meta.note && !dupCheck.note) dupCheck.note = meta.note;
          if (meta.notes && !dupCheck.notes) dupCheck.notes = meta.notes;
          return;
        }
        albums.push({
          id:      newId,
          artist:  s.artist, album: s.album,
          year:    s.year || '', genre: s.genre || '',
          folders: ['stock'],
          has_cd:  false, format: s.format || 'flac',
          note:    meta.note, notes: meta.notes,
          plays:   0, isCompilation: false,
          cd: false, flac: s.format==='flac', mp3: s.format==='mp3', digital: false,
          okFolder: false, forSale: false, primaryFolder: 'stock',
        });
      }
    });
    // Reconstruire stockItems pour compat UI
    stockItems = albums.filter(a => a.folders?.includes('stock'));

    // ── Recalcul systématique de primaryFolder ──────────────────────────────────────────
    // Bug signalé par Antoine : un album déplacé de Stock vers Ok dans MusicBee gardait le
    // badge "📦 Stock" en plus de "✅ Ok" après réimport. Cause confirmée par diagnostic
    // console : primaryFolder était mis à 'stock' plus haut (ex.primaryFolder = 'stock')
    // dès qu'un album matchait un stockAlbums de CET export, mais n'était JAMAIS recalculé
    // quand un album sortait du stock (folders[] se corrigeait bien, primaryFolder restait
    // figé sur 'stock' — c'est justement ce que teste isStock à la ligne ~2127 en fallback
    // `|| a.primaryFolder === 'stock'`, d'où le badge fantôme). primaryFolder est purement
    // dérivé de folders[] (confirmé — aucune écriture manuelle ailleurs dans le code) donc on
    // le recalcule pour TOUS les albums en une passe, après que folders[] a fini de bouger
    // (boucle principale + nettoyage orphelins ok/discographie + réconciliation stock).
    albums.forEach(a => { a.primaryFolder = derivePrimaryFolder(a.folders); });

    const stockDelta = stockAlbums.length;
    const trackDelta = isolatedTracks.length;

    const parts = [];
    if (albumsAdded || albumsUpdated) parts.push(`${albumsAdded} albums ajoutés, ${albumsUpdated} mis à jour`);
    if (orphansCleaned) parts.push(`${orphansCleaned} retiré(s) de Ok/Discographie`);
    parts.push(`${trackDelta} morceaux isolés`);
    parts.push(`${stockDelta} en stock`);

    // Déduplication par ID stable avant sauvegarde Supabase
    const beforeDedup = albums.length;
    const albById = new Map();
    albums.forEach(a => {
      const prev = albById.get(a.id);
      if (!prev) { albById.set(a.id, a); return; }
      // Fusionner : garder la version la plus complète
      if (!prev.discogsId && a.discogsId) prev.discogsId = a.discogsId;
      if (!prev.year && a.year) prev.year = a.year;
      if (!prev.genre && a.genre) prev.genre = a.genre;
      prev.has_cd = prev.has_cd || a.has_cd;
      if (!prev.format && a.format) prev.format = a.format;
      // Fusionner folders
      (a.folders || []).forEach(f => { if (!prev.folders) prev.folders = []; if (!prev.folders.includes(f)) prev.folders.push(f); });
    });
    albums = [...albById.values()];
    if (albums.length < beforeDedup) console.log(`[XML import] ${beforeDedup - albums.length} doublons fusionnés par ID stable`);

    console.log(`[XML import] Résumé : ${albumsAdded} nouveaux, ${albumsUpdated} mis à jour, ${albums.length} total`);
    status.textContent = `✓ XML : ${parts.join(' — ')}`;
    status.className = 'status ok';
    // ── Construire l'ensemble complet des clés présentes dans le XML actuel ──
    const xmlAllKeys = new Set(xmlGroupKeys);
    stockAlbums.forEach(s => {
      if (!s.artist && !s.album) return;
      const albumNorm = normalizeKey('', s.album).replace('|||', '');
      xmlAllKeys.add(normalizeKey(s.artist, s.album));
      for (const av of artistVariants(s.artist)) xmlAllKeys.add(av + '|||' + albumNorm);
    });

    // Albums numériques fantômes : soit plus aucun support après le reset ciblé,
    // soit encore "numérique" en apparence mais absents de toutes les sources du XML actuel
    // (clé jamais matchée par le reset ciblé — ex: tag corrigé, album renommé/fusionné).
    const ghostAlbums = albums.filter(a => {
      if (a.cd) return false;
      if (a.forSale || a.okFolder || (a.note > 0)) return false;
      if (stockItems.find(s => normalizeKey(s.artist, s.album) === normalizeKey(a.artist, a.album))) return false;
      const noSupport = !a.flac && !a.mp3 && !a.digital;
      if (noSupport) return true;
      const albumNorm = normalizeKey('', a.album).replace('|||', '');
      const aKey = normalizeKey(a.artist, a.album);
      if (xmlAllKeys.has(aKey)) return false;
      for (const av of artistVariants(a.artist)) {
        if (xmlAllKeys.has(av + '|||' + albumNorm)) return false;
      }
      return true;
    });
    let removedAlbums = 0;
    if (ghostAlbums.length) {
      const listStr = ghostAlbums.slice(0, 20).map(a => `• ${a.artist} — ${a.album}`).join('\n')
        + (ghostAlbums.length > 20 ? `\n… et ${ghostAlbums.length - 20} autres` : '');
      if (confirm(
        `${ghostAlbums.length} album${ghostAlbums.length > 1 ? 's' : ''} n'ont plus aucun support après l'import ` +
        `(ni CD, ni numérique) :\n\n${listStr}\n\nSupprimer ces entrées ?`
      )) {
        const ghostIds = new Set(ghostAlbums.map(a => a.id));
        albums = albums.filter(a => !ghostIds.has(a.id));
        removedAlbums = ghostAlbums.length;
      }
    }

window._skipLoadAlbumTracks = true;
    const tlCount = importMusicBeeTracklists(trackDicts, str, num, dateStr, isolatedTracks);
    console.log(`importMusicBeeTracklists résultat : ${tlCount} albums`);
    setTimeout(() => { window._skipLoadAlbumTracks = false; }, 10000);

     // ── Wishlist morceaux : proposer de retirer les titres désormais possédés ──
    const matchedWishTracks = trackWishlist.filter(w => importedTrackKeys.has(normalizeKey(w.artist, w.title)));
    if (matchedWishTracks.length) {
      const n = matchedWishTracks.length;
      const listStr = matchedWishTracks.slice(0, 20).map(w => `• ${w.artist} — ${w.title}`).join('\n')
        + (n > 20 ? `\n… et ${n - 20} autres` : '');
      if (confirm(
        `${n} morceau${n > 1 ? 'x' : ''} de la wishlist morceaux semble${n > 1 ? 'nt' : ''} maintenant présent${n > 1 ? 's' : ''} dans votre bibliothèque :\n\n${listStr}\n\nLes retirer de la wishlist morceaux ?`
      )) {
        const matchedIds = new Set(matchedWishTracks.map(w => w.id));
        trackWishlist = trackWishlist.filter(w => !matchedIds.has(w.id));
        renderTrackWishlist();
        updateNavBadges();
      }
    }

     // ── Wishlist albums : proposer de retirer les albums désormais possédés ──
    // (même logique que pruneWishlistOwned, mais avec confirmation explicite au lieu d'un
    // retrait silencieux — pruneWishlistOwned() sera de toute façon appelée automatiquement
    // ensuite via updateNavBadges() ; on l'anticipe ici uniquement pour informer l'utilisateur)
    const ownedNow = wishlistOwnedSet();
    const matchedWishAlbums = wishlist.filter(w =>
      (w.source === 'lastfm' || w.source === 'rym') && ownedNow.has(normalizeKey(w.artist, w.album))
    );
    if (matchedWishAlbums.length) {
      const n = matchedWishAlbums.length;
      const listStr = matchedWishAlbums.slice(0, 20).map(w => `• ${w.artist} — ${w.album}`).join('\n')
        + (n > 20 ? `\n… et ${n - 20} autres` : '');
      if (confirm(
        `${n} album${n > 1 ? 's' : ''} de la wishlist albums semble${n > 1 ? 'nt' : ''} maintenant présent${n > 1 ? 's' : ''} dans votre bibliothèque :\n\n${listStr}\n\nLes retirer de la wishlist albums ?`
      )) {
        const matchedIds = new Set(matchedWishAlbums.map(w => w.id));
        wishlist = wishlist.filter(w => !matchedIds.has(w.id));
        renderWishlist();
      }
    }

    invalidateCache();
    renderAlbums(); renderTracks(); renderStock();
    const removedStr = removedAlbums ? `, ${removedAlbums} supprimés` : '';
    toast(`MusicBee XML : ${albumsAdded} nouveaux, ${trackDelta} morceaux, ${stockDelta} stock${removedStr}`);

    // Sauvegarde directe (sans debounce) pour garantir que Supabase reçoit toutes les mises à jour
    if (window._sb) {
      status.textContent += ' — synchronisation Supabase…';
      setSaveIndicator('saving');
      await saveToSupabase();
      status.textContent = status.textContent.replace(' — synchronisation Supabase…', ' — ✓ synchronisé');
    } else {
      _saveToStorageImpl();
    }
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
    console.error('importMusicBeeXML:', e);
  }
  input.value = '';
}

// Helper : dans un dict iTunes, trouver l'élément suivant une <key>
function getKeyValue(dict, key) {
  const kids = Array.from(dict.children);
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].tagName === 'key' && kids[i].textContent === key) return kids[i+1];
  }
  return null;
}

// ===================== IMPORT: MUSICBEE =====================
async function importMusicBee(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-musicbee');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const rows = parseCSV(text);
    let added = 0, updated = 0;

    // Convertir une note MusicBee en étoiles 0-5
    // MusicBee exporte en % (0,20,40,60,80,100) ou en 0-5 selon la version
    function parseMBRating(raw) {
      if (!raw && raw !== 0) return 0;
      const n = parseFloat(raw);
      if (isNaN(n)) return 0;
      if (n > 5) return Math.round(n / 20); // format % → étoiles
      return Math.round(n); // déjà en étoiles
    }

    // Grouper par album — prendre la note max des morceaux
    const grouped = {};
    rows.forEach(row => {
      const artist = row['artist'] || row['album artist'] || row['albumartist'] || '';
      const album = row['album'] || row['album title'] || '';
      if (!album) return;
      const k = normalizeKey(artist, album);
      if (!grouped[k]) grouped[k] = { artist, album, rows: [] };
      grouped[k].rows.push(row);
    });

    Object.values(grouped).forEach(g => {
      const r = g.rows[0];
      const fmt = (r['format'] || r['codec'] || '').toLowerCase();
      const flac = fmt.includes('flac');
      const mp3 = fmt.includes('mp3');
      const year = r['year'] || r['date'] || '';
      const genre = r['genre'] || '';
      const plays = g.rows.reduce((s, rr) => s + (parseInt(rr['plays'] || rr['play count'] || 0) || 0), 0);

      // Note : prendre la valeur max parmi tous les morceaux de l'album
      const note = Math.max(0, ...g.rows.map(rr =>
        parseMBRating(rr['rating'] || rr['rating (0-5)'] || rr['stars'] || rr['note'] || rr['track rating'] || 0)
      ));

      const discogsId = r['discogs_id'] || r['discogs id'] || '';
      let existing = discogsId ? albums.find(a => a.discogsId === discogsId) : null;
      if (!existing) {
        const key = normalizeKey(g.artist, g.album);
        existing = albums.find(a =>
          normalizeKey(a.artist, a.album) === key ||
          normalizeKey(cleanDiscogsArtist(a.artist), a.album) === key
        );
      }

      if (existing) {
        if (flac) existing.flac = true;
        if (mp3) existing.mp3 = true;
        if (plays) existing.plays = (existing.plays || 0) + plays;
        if (genre && !existing.genre && !isManualField(existing, 'genre')) { existing.genre = genre; setProvenance(existing, 'genre', 'musicbee'); }
        if (note && !existing.note) existing.note = note; // n'écrase pas une note existante
        updated++;
      } else {
        const newAlbum = { id: uid(), artist: g.artist, album: g.album, year: year.slice(0, 4), genre, cd: false, flac, mp3, digital: !flac && !mp3, note, plays };
        if (year) setProvenance(newAlbum, 'year', 'musicbee');
        if (genre) setProvenance(newAlbum, 'genre', 'musicbee');
        albums.push(newAlbum);
        added++;
      }
    });

    // Morceaux isolés : noter aussi les tracks individuels
    let tracksRated = 0;
    rows.forEach(row => {
      const title = row['title'] || row['track title'] || '';
      const artist = row['artist'] || '';
      if (!title || !artist) return;
      const note = parseMBRating(row['rating'] || row['rating (0-5)'] || row['stars'] || row['note'] || 0);
      if (!note) return;
      const existing = tracks.find(t =>
        t.title.toLowerCase() === title.toLowerCase() &&
        t.artist.toLowerCase() === artist.toLowerCase()
      );
      if (existing && !existing.note) { existing.note = note; tracksRated++; }
    });

    status.textContent = `✓ ${added} albums ajoutés, ${updated} mis à jour${tracksRated ? `, ${tracksRated} morceaux notés` : ''}`;
    status.className = 'status ok';
    renderAlbums();
    toast(`MusicBee : ${added} albums, ${updated} mis à jour`);
    saveToStorage();
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}

// ===================== IMPORT: M3U (MUSICBEE) =====================
async function importM3U(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-musicbee');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Détecter le type de playlist selon le nom de fichier ET les chemins
    const fileName = file.name.toLowerCase();
    const isTrackPlaylist = /top.?ti|top.?track|favorite|best|singles?|isolé/i.test(fileName);
    const isStockPlaylist = /!_00_stock|00.stock/i.test(fileName);

    const grouped = {};       // albums normaux
    const isolatedTracks = []; // morceaux isolés (top titres)
    const stockAlbums = [];    // albums stock (!_00_stock)
    let currentMeta = null;

    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        // Format MusicBee étendu : #EXTINF:duration,Artist - Title
        // ou avec tags : #EXTINF:duration tvg-name="..." rating="80"
        const meta = line.slice(line.indexOf(',') + 1).trim();
        const dashIdx = meta.indexOf(' - ');
        let artist = '', title = meta;
        if (dashIdx !== -1) { artist = meta.slice(0, dashIdx).trim(); title = meta.slice(dashIdx + 3).trim(); }

        // Extraire la note depuis les attributs EXTINF si présents
        // Formats possibles : rating="80" ou #RATING:80 sur la ligne suivante
        const ratingMatch = line.match(/rating[=:]["']?(\d+)/i);
        const rating = ratingMatch ? Math.round(parseInt(ratingMatch[1]) / 20) : 0; // % → étoiles

        currentMeta = { artist, title, rating };
      } else if (line.startsWith('#RATING:')) {
        // Tag MusicBee séparé : #RATING:80
        const r = parseInt(line.split(':')[1]) || 0;
        if (currentMeta) currentMeta.rating = Math.round(r / 20);
      } else if (!line.startsWith('#')) {
        const parts = line.replace(/\\/g, '/').split('/');
        const filename = parts[parts.length - 1];
        const ext = filename.split('.').pop().toLowerCase();
        const isFlac = ext === 'flac';
        const isMp3 = ext === 'mp3';
        const isAac = ['aac','m4a','alac'].includes(ext);
        const format = isFlac ? 'flac' : isMp3 ? 'mp3' : isAac ? 'aac' : 'autre';

        let albumFromPath = '', artistFromPath = '';
        if (parts.length >= 3) { albumFromPath = parts[parts.length-2]; artistFromPath = parts[parts.length-3]; }
        else if (parts.length >= 2) { albumFromPath = parts[parts.length-2]; }

        const artistMeta = (currentMeta?.artist || artistFromPath || '').trim();
        const titleMeta = (currentMeta?.title || filename.replace(/\.\w+$/,'')).trim();
        const albumRaw = albumFromPath.trim();
        const albumClean = albumRaw.replace(/^\d+\s*[-–]\s*/,'').trim();
        const artistClean = artistMeta.replace(/^\d+\s*[-–]\s*/,'').trim();

        // Détecter le dossier dans le chemin complet
        const pathLower = line.toLowerCase().replace(/\\/g,'/');
        const folderIsStock = pathLower.includes('!_00_stock') || isStockPlaylist;
        const folderIsTopTitres = pathLower.includes('top titres') || pathLower.includes('top-titres') || pathLower.includes('top_titres') || /top.?ti/i.test(albumRaw) || isTrackPlaylist;
        const folderIsTopTracks = /top.?track|favorite|best|single|isolé/i.test(albumRaw);

        if (folderIsStock) {
          if (!artistClean && !albumClean) { currentMeta = null; continue; }
          const key = normalizeKey(artistClean, albumClean);
          if (!stockAlbums.find(s => normalizeKey(s.artist, s.album) === key)) {
            stockAlbums.push({ artist: artistClean, album: albumClean, format });
          }
        } else if (folderIsTopTitres || folderIsTopTracks) {
          if (!artistClean && !titleMeta) { currentMeta = null; continue; }
          isolatedTracks.push({ title: titleMeta, artist: artistClean || artistFromPath, album: '', format, rating: currentMeta?.rating || 0 });
        } else {
          if (!artistClean && !albumClean) { currentMeta = null; continue; }
          const key = normalizeKey(artistClean, albumClean);
          if (!grouped[key]) grouped[key] = { artist: artistClean, album: albumClean, tracks: 0, flac: false, mp3: false, digital: false, maxRating: 0 };
          grouped[key].tracks++;
          if (isFlac) grouped[key].flac = true;
          else if (isMp3) grouped[key].mp3 = true;
          else grouped[key].digital = true;
          // Prendre la note max parmi tous les morceaux de l'album
          const r = currentMeta?.rating || 0;
          if (r > grouped[key].maxRating) grouped[key].maxRating = r;
        }
        currentMeta = null;
      }
    }

	let albumsAdded = 0, albumsUpdated = 0, tracksAdded = 0, tracksUpdated = 0, stockAdded = 0, stockUpdated = 0;

    // Albums normaux
    Object.values(grouped).forEach(g => {
      if (!g.artist && !g.album) return;
      const key = normalizeKey(g.artist, g.album);
      const existing = albums.find(a => normalizeKey(a.artist, a.album) === key);
      if (existing) {
        if (g.flac) existing.flac = true;
        if (g.mp3) existing.mp3 = true;
        if (g.digital) existing.digital = true;
        if (g.maxRating && !existing.note) existing.note = g.maxRating;
        albumsUpdated++;
      } else {
        albums.push({ id: uid(), artist: g.artist, album: g.album, year:'', genre:'', cd:false, flac:g.flac, mp3:g.mp3, digital:g.digital, note: g.maxRating || 0, plays:0 });
        albumsAdded++;
      }
    });

    // Morceaux isolés
    isolatedTracks.forEach(t => {
      if (!t.title || !t.artist) return;
      const existing = tracks.find(x => x.title.toLowerCase()===t.title.toLowerCase() && x.artist.toLowerCase()===t.artist.toLowerCase());
      if (existing) {
        if (t.rating && !existing.note) existing.note = t.rating;
        tracksUpdated++;
      } else {
        tracks.push({ id: uid(), title: t.title, artist: t.artist, album: '', format: t.format, duration: '', note: t.rating || 0 });
        tracksAdded++;
      }
    });

    // Stock
    stockAlbums.forEach(s => {
      const key = normalizeKey(s.artist, s.album);
      const existing = stockItems.find(x => normalizeKey(x.artist, x.album) === key);
      if (existing) { stockUpdated++; }
      else { stockItems.push({ id: uid(), artist: s.artist, album: s.album, year:'', genre:'', format: s.format, note:0, notes:'' }); stockAdded++; }
    });

    const parts2 = [];
    if (albumsAdded || albumsUpdated) parts2.push(`${albumsAdded} albums ajoutés, ${albumsUpdated} mis à jour`);
    if (tracksAdded || tracksUpdated) parts2.push(`${tracksAdded} morceaux isolés`);
    if (stockAdded || stockUpdated) parts2.push(`${stockAdded} en stock`);
    status.textContent = `✓ M3U : ${parts2.join(' — ') || 'aucune entrée'}`;
    status.className = 'status ok';
    invalidateCache();
    renderAlbums(); renderTracks(); renderStock();
    toast(`M3U : ${albumsAdded + tracksAdded + stockAdded} nouvelles entrées`);
    saveToStorage();
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}


function updateLastSyncLabel() {
  const el = document.getElementById('lastfm-last-sync-label');
  if (!el) return;
  const ts = localStorage.getItem(LASTFM_SYNC_KEY);
  if (!ts) { el.textContent = 'jamais'; return; }
  const d = new Date(parseInt(ts) * 1000);
  el.textContent = d.toLocaleDateString('fr-FR') + ' à ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
}


let _lastfmApiKey = 'e8aae3c9ca05ced8f56443c1108fdc65';
let _lastfmUser = 'terant';
let _lastfmTotalPages = 0;
let _lastfmCurrentPage = 0;
let _lastfmCounts = {};
let _lastfmAbort = false;
const LASTFM_PAGE_SIZE = 200;
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_SYNC_KEY = 'lastfm_last_sync';

// Sync automatique last.fm au démarrage — silencieuse, incrémentale uniquement
async function autoSyncLastfm() {
  if (!_lastfmApiKey || !_lastfmUser) return;
  if (_lastfmSyncRunning) return;
  const lastSyncRaw = localStorage.getItem(LASTFM_SYNC_KEY);
  if (!lastSyncRaw) return; // pas de sync complète préalable — ne pas lancer
  const lastSyncTs = parseInt(lastSyncRaw);

  try {
    const infoUrl = `${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json`;
    const infoRes = await fetch(infoUrl);
    const infoData = await infoRes.json();
    if (infoData.error) return;

    // Reconstruire les counts depuis lastfmData chargé
    _lastfmCounts = {};
    lastfmData.forEach(d => { _lastfmCounts[normalizeKey(d.artist, d.album)] = { artist: d.artist, album: d.album, plays: d.plays }; });

    // Lancer la sync incrémentale silencieuse
    await fetchLastfmIncrementalSilent(lastSyncTs);
  } catch(e) {
    console.log('Auto-sync last.fm ignorée :', e.message);
  }
}

async function fetchLastfmIncrementalSilent(fromTs) {
  let page = 1;
  let totalNewScrobbles = 0;
  let latestTs = fromTs;
  let done = false;

  while (!done) {
    try {
      const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=${LASTFM_PAGE_SIZE}&page=${page}&from=${fromTs + 1}&extended=0`;
      const res = await fetch(url);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 15000)); continue; }
      const data = await res.json();
      if (data.error === 11 || data.error === 16) {
        await new Promise(r => setTimeout(r, 10000));
        page++; // éviter boucle infinie sur la même page
        continue;
      }
      if (data.error) return;

      const tracks = data.recenttracks?.track || [];
      const totalPages = parseInt(data.recenttracks?.['@attr']?.totalPages || 1);
      const total = parseInt(data.recenttracks?.['@attr']?.total || 0);

      tracks.forEach(t => {
        if (t['@attr']?.nowplaying) return;
        const artist = String(t.artist?.['#text'] || t.artist?.name || t.artist || '').trim();
        const album = String(t.album?.['#text'] || t.album?.name || (typeof t.album === 'string' ? t.album : '') || '').trim();
        const ts = parseInt(t.date?.uts || 0);
        if (ts > latestTs) latestTs = ts;
        if (!artist || !album) return;
        const k = normalizeKey(artist, album);
        if (!_lastfmCounts[k]) _lastfmCounts[k] = { artist, album, plays: 0 };
        _lastfmCounts[k].plays++;
        totalNewScrobbles++;
      });

      if (page >= totalPages || tracks.length === 0) { done = true; }
      else { page++; await new Promise(r => setTimeout(r, 220)); }
    } catch(e) {
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  if (totalNewScrobbles === 0) return; // rien de nouveau, pas besoin de sauvegarder

  // Mettre à jour lastfmData
  lastfmData = Object.values(_lastfmCounts);
  applyLastfmPlaysToAlbums(lastfmData);

  if (latestTs > fromTs) {
    localStorage.setItem(LASTFM_SYNC_KEY, String(latestTs));
    updateLastSyncLabel();
    if (window._sb) {
      window._sb.from('meta').upsert({ key: 'lastfm_sync_ts', value: String(latestTs) }, { onConflict: 'key' }).then(() => {});
    }
  }

  invalidateCache();

  // Sauvegarder uniquement les entrées modifiées dans Supabase
  if (window._sb) {
    const updatedRows = lastfmData.map(d => ({ artist: d.artist, album: d.album, plays: d.plays }));
    try {
      // Dédoublonner avant upsert incrémental
      const updDedup = new Map();
      updatedRows.forEach(r => {
        const k = r.artist + '|||' + r.album;
        if (!updDedup.has(k) || r.plays > (updDedup.get(k).plays||0)) updDedup.set(k, r);
      });
      await sbUpsert('lastfm_data', [...updDedup.values()], 'artist,album');
    } catch(e) { console.error('Erreur sauvegarde lastfm Supabase:', e); }
  }

  renderAlbums();
  updateNavBadges();
  toast(`last.fm : +${totalNewScrobbles.toLocaleString('fr-FR')} nouveaux scrobbles`);
}


let _lastfmSyncRunning = false;

async function connectLastfm() {
  if (_lastfmSyncRunning) {
    const status = document.getElementById('status-lastfm');
    if (status) { status.textContent = 'Synchronisation déjà en cours…'; status.className = 'status'; }
    return;
  }
  const status = document.getElementById('status-lastfm');
  const apiKey = document.getElementById('lastfm-apikey').value.trim();
  const user = document.getElementById('lastfm-user').value.trim();
  if (!apiKey || !user) {
    status.textContent = 'Clé API et nom d\'utilisateur requis.';
    status.className = 'status err';
    return;
  }
  _lastfmSyncRunning = true;
  _lastfmApiKey = apiKey;
  _lastfmUser = user;
  _lastfmCurrentPage = 0;
  _lastfmTotalPages = 0;
  _lastfmAbort = false;

  localStorage.setItem('lastfm_cfg', JSON.stringify({ apiKey, user }));

  // Récupérer la date du dernier scrobble connu
  const lastSyncRaw = localStorage.getItem(LASTFM_SYNC_KEY);
  const lastSyncTs = lastSyncRaw ? parseInt(lastSyncRaw) : 0;
  const isIncremental = lastSyncTs > 0;

  status.textContent = isIncremental
    ? `Recherche des nouveaux scrobbles depuis le ${new Date(lastSyncTs * 1000).toLocaleDateString('fr-FR')}…`
    : 'Première synchronisation complète…';
  status.className = 'status';

  try {
    const infoUrl = `${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json`;
    const infoRes = await fetch(infoUrl);
    const infoData = await infoRes.json();
    if (infoData.error) {
      // Erreur 11 = service temporairement indisponible, on réessaie
      if (infoData.error === 11 || infoData.error === 16) {
        status.textContent = 'Serveur last.fm indisponible, nouvelle tentative dans 5s…';
        await new Promise(r => setTimeout(r, 5000));
        // Réessai direct (une seule fois) sans récursion
        const retryRes = await fetch(infoUrl);
        const retryData = await retryRes.json();
        if (retryData.error) {
          status.textContent = 'Serveur last.fm toujours indisponible — réessayez manuellement.';
          status.className = 'status err';
          return;
        }
        Object.assign(infoData, retryData);
      }
      status.textContent = 'Erreur last.fm : ' + infoData.message;
      status.className = 'status err';
      return;
    }
    const totalScrobbles = parseInt(infoData.user?.playcount || 0);

    if (isIncremental) {
      // Sync incrémentale : on récupère uniquement depuis lastSyncTs
      _lastfmCounts = {};
      // Reconstruire les counts existants depuis lastfmData sauvegardé
      lastfmData.forEach(d => { _lastfmCounts[normalizeKey(d.artist, d.album)] = d; });
      await fetchLastfmIncremental(lastSyncTs);
    } else {
      // Première fois : chargement complet
      _lastfmCounts = {};
      // fetchLastfmPage() alimente aussi _lastfmTrackCounts au passage (indexation morceaux) —
      // le réinitialiser ici aussi, par cohérence avec le même correctif appliqué à
      // startTrackSync() (sinon un full sync album relancé après un sync morceaux existant
      // gonflerait ces compteurs-là de la même façon).
      _lastfmTrackCounts = {};
      _lastfmTotalPages = Math.ceil(totalScrobbles / LASTFM_PAGE_SIZE);
      status.textContent = `✓ Connecté — ${totalScrobbles.toLocaleString('fr-FR')} scrobbles à charger`;
      status.className = 'status ok';
      await fetchLastfmPage(1);
    }
	} catch(e) {
    status.textContent = 'Erreur réseau : ' + e.message;
    status.className = 'status err';
  } finally {
    _lastfmSyncRunning = false;
  }
}

// ===================== SYNC TRACKS UNIQUEMENT =====================
let _trackSyncAbort = false;

async function startTrackSync() {
  const btn   = document.getElementById('btn-tracks-sync');
  const status = document.getElementById('status-lastfm');
  const progress = document.getElementById('lastfm-progress');
  const bar = document.getElementById('lastfm-bar');
  const progressLabel = document.getElementById('lastfm-progress-label');

  // Pause si déjà en cours
  if (btn.dataset.running === '1') {
    _trackSyncAbort = true;
    btn.dataset.running = '0';
    btn.textContent = '🎵 Sync morceaux complète';
    status.textContent = 'Sync morceaux interrompue.';
    return;
  }

  const apiKey = document.getElementById('lastfm-apikey').value.trim();
  const user   = document.getElementById('lastfm-user').value.trim();
  if (!apiKey || !user) { status.textContent = 'Clé API et nom d\'utilisateur requis.'; return; }

  if (!window._sb) {
    status.textContent = 'Supabase non connecté — la table lastfm_tracks ne sera pas remplie.';
    status.className = 'status err';
    return;
  }

  _trackSyncAbort = false;
  btn.dataset.running = '1';
  btn.textContent = '⏸ Pause morceaux';
  status.textContent = 'Récupération du nombre de scrobbles…';
  status.className = 'status';
  progress.style.display = 'block';
  bar.style.width = '0%';

  try {
    // Total scrobbles
    const infoUrl = `${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json`;
    const infoData = await (await fetch(infoUrl)).json();
    if (infoData.error) { status.textContent = 'Erreur last.fm : ' + infoData.message; status.className = 'status err'; return; }
    const totalScrobbles = parseInt(infoData.user?.playcount || 0);
    const totalPages = Math.ceil(totalScrobbles / LASTFM_PAGE_SIZE);

    // Checkpoint léger (localStorage) pour reprendre si pause
    const TRACK_CP_KEY = 'lastfm_track_sync_page';
    let startPage = 1;
    let resumed = false;
    try {
      const cp = JSON.parse(localStorage.getItem(TRACK_CP_KEY) || 'null');
      if (cp && cp.totalPages === totalPages && cp.page > 1) {
        if (confirm(`Reprendre la sync morceaux depuis la page ${cp.page} / ${totalPages} ?`)) {
          startPage = cp.page;
          // Restaurer les counts déjà accumulés — clé composite IDENTIQUE à celle utilisée dans
          // la boucle principale (artiste+titre+album), sinon les entrées restaurées et les
          // entrées re-comptées à la reprise atterrissent dans des clés différentes et se
          // dupliquent au lieu de se cumuler.
          if (cp.counts) {
            _lastfmTrackCounts = {};
            cp.counts.forEach(d => {
              const kt = normalizeKey(d.a, d.t) + '|' + normalizeKey('', d.b || '');
              _lastfmTrackCounts[kt] = { artist: d.a, track: d.t, album: d.b || '', plays: d.p };
            });
          }
          resumed = true;
        }
      }
    } catch(e) {}
    if (!resumed) {
      // BUG HISTORIQUE (corrigé ici) : une sync complète relancée depuis zéro repartait des
      // compteurs déjà en mémoire (chargés depuis Supabase au démarrage de l'app, donc déjà
      // corrects) et les incrémentait une seconde fois par-dessus en re-scannant tout
      // l'historique — chaque relance de "Sync morceaux complète" gonflait donc tous les
      // compteurs (x2, x3...). Une sync complète DOIT repartir d'une base vierge, puisqu'elle
      // recompte de toute façon l'intégralité de l'historique last.fm à chaque fois (pas de
      // mode incrémental pour les morceaux, contrairement aux albums).
      _lastfmTrackCounts = {};
    }

    status.textContent = `Sync morceaux : ${totalScrobbles.toLocaleString('fr-FR')} scrobbles, ${totalPages} pages — page ${startPage} →`;
    status.className = 'status';

    for (let page = startPage; page <= totalPages && !_trackSyncAbort; page++) {
      // Délai respectueux du rate-limit last.fm
      if (page > startPage) await new Promise(r => setTimeout(r, 220));

      let data, retries = 0;
      while (retries < 3) {
        try {
          const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json&limit=${LASTFM_PAGE_SIZE}&page=${page}&extended=0`;
          const res = await fetch(url);
          data = await res.json();
          if (data.error === 11 || data.error === 16) {
            progressLabel.textContent = `Limite API, pause 15s… (page ${page}/${totalPages})`;
            await new Promise(r => setTimeout(r, 15000));
            retries++; continue;
          }
          break;
        } catch(e) { retries++; await new Promise(r => setTimeout(r, 3000)); }
      }
      if (!data?.recenttracks?.track) continue;

      const tracks = Array.isArray(data.recenttracks.track)
        ? data.recenttracks.track
        : [data.recenttracks.track];

      tracks.forEach(t => {
        if (t['@attr']?.nowplaying) return;
        const artist = String(t.artist?.['#text'] || t.artist?.name || t.artist || '').trim();
        const track  = String(t.name || '').trim();
        const album  = String(t.album?.['#text'] || t.album?.name || (typeof t.album === 'string' ? t.album : '') || '').trim();
        if (!artist || !track) return;
        const kt = normalizeKey(artist, track) + '|' + normalizeKey('', album);
        if (!_lastfmTrackCounts[kt]) _lastfmTrackCounts[kt] = { artist, track, album: album || '', plays: 0 };
        _lastfmTrackCounts[kt].plays++;
      });

      const pct = Math.round((page / totalPages) * 100);
      bar.style.width = pct + '%';
      const nT = Object.keys(_lastfmTrackCounts).length;
      progressLabel.textContent = `Page ${page}/${totalPages} — ${(page * LASTFM_PAGE_SIZE).toLocaleString('fr-FR')} scrobbles traités — ${nT.toLocaleString('fr-FR')} morceaux distincts`;

      // Checkpoint toutes les 10 pages
      if (page % 10 === 0) {
        const compact = Object.values(_lastfmTrackCounts).map(d => ({ a: d.artist, t: d.track, b: d.album || '', p: d.plays }));
        try { localStorage.setItem(TRACK_CP_KEY, JSON.stringify({ page: page + 1, totalPages, counts: compact, savedAt: Date.now() })); } catch(e) {}
      }

      // Flush Supabase toutes les 50 pages
      if (page % 50 === 0) {
        progressLabel.textContent += ' — flush Supabase…';
        await flushTrackCountsToSupabase();
        // Mise à jour badge nav morceaux manquants
        invalidateCache();
        const mtBadge = document.getElementById('nav-missing-tracks-count');
        if (mtBadge) {
          const ownedT = new Set(tracks.map(t => normalizeKey(t.artist, t.title)));
          const missingCnt = Object.values(_lastfmTrackCounts)
            .filter(d => !ownedT.has(normalizeKey(d.artist, d.track))).length;
          mtBadge.textContent = missingCnt;
        }
      }
    }

    if (!_trackSyncAbort) {
      // Flush final
      progressLabel.textContent = 'Flush final vers Supabase…';
      await flushTrackCountsToSupabase();
      localStorage.removeItem(TRACK_CP_KEY);
      const nT = Object.keys(_lastfmTrackCounts).length;
      status.textContent = `✓ Sync morceaux terminée — ${nT.toLocaleString('fr-FR')} morceaux distincts dans lastfm_tracks`;
      status.className = 'status ok';
      bar.style.width = '100%';
      toast(`lastfm_tracks : ${nT.toLocaleString('fr-FR')} morceaux synchronisés`);
      // Invalider le cache et actualiser les onglets concernés
      invalidateCache();
      if (document.getElementById('sec-tracks')?.style.display !== 'none') renderTracks();
      if (document.getElementById('sec-missing-tracks')?.style.display !== 'none') renderMissingTracks();
      updateNavBadges();
    } else {
      status.textContent = 'Sync morceaux interrompue — les données partielles sont sauvegardées.';
      status.className = 'status';
    }
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
    console.error('startTrackSync:', e);
  } finally {
    btn.dataset.running = '0';
    btn.textContent = '🎵 Sync morceaux complète';
    progress.style.display = 'none';
  }
}

async function fetchLastfmIncremental(fromTs) {
  const status = document.getElementById('status-lastfm');
  const progress = document.getElementById('lastfm-progress');
  const bar = document.getElementById('lastfm-bar');
  const progressLabel = document.getElementById('lastfm-progress-label');
  const btnMore = document.getElementById('btn-lastfm-more');

  progress.style.display = 'block';
  btnMore.style.display = 'none';

  let page = 1;
  let totalNewScrobbles = 0;
  let latestTs = fromTs;
  let done = false;

  while (!done && !_lastfmAbort) {
    try {
      const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=${LASTFM_PAGE_SIZE}&page=${page}&from=${fromTs + 1}&extended=0`;
      const res = await fetch(url);
      if (res.status === 429) {
        progressLabel.textContent = 'Limite API, pause 10s…';
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      const data = await res.json();
      if (data.error) {
        if (data.error === 11 || data.error === 16) {
          progressLabel.textContent = 'Serveur last.fm indisponible, pause 10s…';
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        status.textContent = 'Erreur last.fm : ' + data.message;
        status.className = 'status err';
        progress.style.display = 'none';
        return;
      }

      const tracks = data.recenttracks?.track || [];
      const totalPages = parseInt(data.recenttracks?.['@attr']?.totalPages || 1);
      const total = parseInt(data.recenttracks?.['@attr']?.total || 0);

      tracks.forEach(t => {
        if (t['@attr']?.nowplaying) return;
        const artist = String(t.artist?.['#text'] || t.artist?.name || t.artist || '').trim();
        const album = String(t.album?.['#text'] || t.album?.name || (typeof t.album === 'string' ? t.album : '') || '').trim();
        const ts = parseInt(t.date?.uts || 0);
        if (ts > latestTs) latestTs = ts;
        if (!artist || !album) return;
        const k = normalizeKey(artist, album);
        if (!_lastfmCounts[k]) _lastfmCounts[k] = { artist, album, plays: 0 };
        _lastfmCounts[k].plays++;
        totalNewScrobbles++;
      });

      const pct = totalPages > 1 ? Math.round((page / totalPages) * 100) : 100;
      bar.style.width = pct + '%';
      progressLabel.textContent = `Page ${page}/${totalPages} — ${total.toLocaleString('fr-FR')} nouveaux scrobbles`;

      if (page >= totalPages || tracks.length === 0) {
        done = true;
      } else {
        page++;
        await new Promise(r => setTimeout(r, 220));
      }
    } catch(e) {
      progressLabel.textContent = 'Erreur réseau, nouvelle tentative…';
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Finaliser
  lastfmData = Object.values(_lastfmCounts);
  applyLastfmPlaysToAlbums(lastfmData);

  if (latestTs > fromTs) {
    localStorage.setItem(LASTFM_SYNC_KEY, String(latestTs));
    updateLastSyncLabel();
    // Persister le timestamp dans Supabase pour les autres appareils
    if (window._sb) {
      window._sb.from('meta').upsert({ key: 'lastfm_sync_ts', value: String(latestTs) }, { onConflict: 'key' }).then(() => {});
    }
  }
  progress.style.display = 'none';

  if (totalNewScrobbles === 0) {
    status.textContent = '✓ Déjà à jour — aucun nouveau scrobble';
    status.className = 'status ok';
  } else {
    status.textContent = `✓ +${totalNewScrobbles.toLocaleString('fr-FR')} nouveaux scrobbles — ${lastfmData.length} albums au total`;
    status.className = 'status ok';
    toast(`last.fm : +${totalNewScrobbles.toLocaleString('fr-FR')} scrobbles synchronisés`);
  }

  renderAlbums();
  updateNavBadges();
  saveToStorage();
}

// Clés localStorage pour la sauvegarde progressive
const LASTFM_CHECKPOINT_KEY = 'lastfm_checkpoint';
const LASTFM_TRACK_CHECKPOINT_KEY = 'lastfm_track_checkpoint';
let _lastfmTrackCounts = {}; // { normalizeKey(artist,track): { artist, track, plays } }
let _lovedTracks = new Set(); // Set de normalizeKey(artist, track) pour les lovés

// Charger les loved tracks depuis localStorage au démarrage (fallback mode sans Supabase)
// En mode Supabase, le chargement se fait dans loadFromSupabase via metaMap.lastfm_loved
async function loadLovedTracks() {
  try {
    const raw = localStorage.getItem('lastfm_loved');
    if (raw) {
      const arr = JSON.parse(raw);
      _lovedTracks = new Set(arr);
      const countEl = document.getElementById('lastfm-loved-count');
      if (countEl && _lovedTracks.size) countEl.textContent = `❤️ ${_lovedTracks.size} morceaux`;
    }
  } catch(e) {}
}

async function syncLovedTracks() {
  const btn    = document.getElementById('btn-loved-sync');
  const status = document.getElementById('status-lastfm');
  const infoEl = document.getElementById('lastfm-loved-info');
  const label  = document.getElementById('lastfm-loved-label');
  const apiKey = document.getElementById('lastfm-apikey').value.trim();
  const user   = document.getElementById('lastfm-user').value.trim();
  if (!apiKey || !user) { toast('Clé API et nom d\'utilisateur requis', 'error'); return; }

  btn.disabled = true;
  status.textContent = 'Récupération des loved tracks…';
  status.className = 'status';

  try {
    let page = 1, total = 0, fetched = 0;
    _lovedTracks = new Set();

    while (true) {
      await new Promise(r => setTimeout(r, 220));
      const url = `${LASTFM_BASE}?method=user.getlovedtracks&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json&limit=200&page=${page}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.message || `Erreur last.fm ${data.error}`);

      const loved = data.lovedtracks?.track || [];
      const totalPages = parseInt(data.lovedtracks?.['@attr']?.totalPages || 1);
      total = parseInt(data.lovedtracks?.['@attr']?.total || 0);

      loved.forEach(t => {
        const artist = String(t.artist?.name || t.artist?.['#text'] || '').trim();
        const track  = String(t.name || '').trim();
        if (artist && track) {
          _lovedTracks.add(normalizeKey(artist, track));
          // Aussi variante artiste nettoyé
          const clean = cleanDiscogsArtist(artist);
          if (clean !== artist) _lovedTracks.add(normalizeKey(clean, track));
        }
        fetched++;
      });

      status.textContent = `Loved tracks : page ${page}/${totalPages} — ${fetched} chargés…`;
      if (page >= totalPages || !loved.length) break;
      page++;
    }

    // Persister
    const arr = [..._lovedTracks];
    try { localStorage.setItem('lastfm_loved', JSON.stringify(arr)); } catch(e) {}
    if (window._sb) {
      await window._sb.from('meta').upsert(
        { key: 'lastfm_loved', value: JSON.stringify(arr) },
        { onConflict: 'key' }
      );
    }

    status.textContent = `✓ ${fetched} loved tracks synchronisés`;
    status.className = 'status ok';
    if (infoEl) {
      infoEl.style.display = 'block';
      label.textContent = `❤️ ${fetched} loved tracks — dernière sync : ${new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})}`;
    }
    invalidateCache();
    if (document.getElementById('sec-tracks')?.classList.contains('active')) renderTracks();
    toast(`❤️ ${fetched} loved tracks synchronisés`);
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  } finally {
    btn.disabled = false;
  }
}

// ===================== LISTENBRAINZ SYNC =====================
const LB_BASE = 'https://api.listenbrainz.org/1';

async function syncListenBrainz() {
  const btn    = document.getElementById('btn-lb-sync');
  const status = document.getElementById('status-lastfm');
  const progress = document.getElementById('lastfm-progress');
  const bar = document.getElementById('lastfm-bar');
  const progressLabel = document.getElementById('lastfm-progress-label');
  const user = (document.getElementById('lastfm-user')?.value || 'terant').trim();

  // Toggle pause si sync en cours
  if (_lbSyncRunning) {
    _lbSyncAbort = true;
    btn.textContent = '🔵 Sync ListenBrainz';
    return;
  }

  const lastSyncRaw = localStorage.getItem(LB_SYNC_KEY);
  const lastSyncTs  = lastSyncRaw ? parseInt(lastSyncRaw) : 0;
  const isIncremental = lastSyncTs > 0;

  _lbSyncRunning = true;
  _lbSyncAbort   = false;
  btn.textContent = '⏸ Pause LB';
  btn.disabled = false;
  status.className = 'status';
  progress.style.display = 'block';
  bar.style.width = '0%';

  status.textContent = isIncremental
    ? `LB : enrichissement MBID depuis ${new Date(lastSyncTs * 1000).toLocaleDateString('fr-FR')}…`
    : 'LB : premier enrichissement MBID complet (n\u2019affecte pas les compteurs d\u2019écoutes)…';

  // last.fm reste la SEULE source des compteurs d'écoutes (plays) — ListenBrainz ne sert plus
  // qu'à enrichir les MBID sur les entrées déjà comptées par last.fm. On repart donc toujours de
  // lastfmData (source de vérité persistée) avant de traiter les listens LB, jamais d'un reset à
  // vide : un reset ici effaçait l'historique last.fm déjà correct dès que _lastfmCounts n'était
  // pas encore rechargé en mémoire (ex: après un rechargement de page), et l'ancien code
  // incrémentait en plus ses propres compteurs LB par-dessus — les deux sources rapportant les
  // mêmes écoutes réelles (un même scrobbler soumettant à last.fm ET ListenBrainz), ça doublait
  // le total pour toute écoute plus récente que le dernier sync LB (ex: 8 écoutes réelles → 16
  // affichées). _lastfmTrackCounts n'est plus jamais reset ici non plus, pour la même raison.
  _lastfmCounts = {};
  lastfmData.forEach(d => {
    _lastfmCounts[normalizeKey(d.artist, d.album)] = { artist: d.artist, album: d.album, plays: d.plays || 0, release_mbid: d.release_mbid || '' };
  });

  // Récupérer le listen-count total pour la barre de progression
  let totalListens = 0;
  try {
    const infoRes = await fetch(`${LB_BASE}/user/${encodeURIComponent(user)}/listen-count`);
    if (infoRes.ok) {
      const infoData = await infoRes.json();
      totalListens = infoData.payload?.count || 0;
      if (!isIncremental) status.textContent = `LB : ${totalListens.toLocaleString('fr-FR')} écoutes à récupérer…`;
    }
  } catch(e) { /* non bloquant */ }

	let _restoredFromCheckpoint = false;
	if (!isIncremental) {
		try {
		const cp = JSON.parse(localStorage.getItem('lb_checkpoint') || 'null');
		if (cp && cp.maxTs && cp.totalFetched > 0) {
			if (confirm(`Reprendre la sync ListenBrainz depuis ${cp.totalFetched.toLocaleString('fr-FR')} écoutes déjà traitées ?`)) {
			// Ne restaure QUE la position de pagination (maxTs/totalFetched) — les compteurs
			// eux-mêmes viennent uniquement de lastfmData (voir plus haut), jamais du checkpoint.
			_restoredFromCheckpoint = true;
			status.textContent = `LB : reprise depuis ${cp.totalFetched.toLocaleString('fr-FR')} écoutes…`;
			}
		}
		} catch(e) {}
	}

  let totalFetched = (() => { try { const cp = JSON.parse(localStorage.getItem('lb_checkpoint')||'null'); return (_restoredFromCheckpoint && cp) ? cp.totalFetched : 0; } catch(e) { return 0; } })();
  let latestTs = lastSyncTs;
  let maxTs = (() => { try { const cp = JSON.parse(localStorage.getItem('lb_checkpoint')||'null'); return (_restoredFromCheckpoint && cp) ? cp.maxTs : null; } catch(e) { return null; } })();
  let done = false;
  let errorStreak = 0;
  let albumsMbidEnriched = 0;
  let tracksMbidEnriched = 0;

  // Index MBID albums collection pour matching rapide
  const mbReleaseIndex = new Map();
  albums.forEach(a => { if (a.mb_release_id) mbReleaseIndex.set(a.mb_release_id, a); });

  while (!done && !_lbSyncAbort) {
    try {
      let url;
      if (isIncremental) {
        url = `${LB_BASE}/user/${encodeURIComponent(user)}/listens?count=1000&min_ts=${lastSyncTs}`;
      } else {
        url = `${LB_BASE}/user/${encodeURIComponent(user)}/listens?count=1000`;
        if (maxTs) url += `&max_ts=${maxTs}`;
      }

      await new Promise(r => setTimeout(r, 300));
      const res = await fetch(url);

      if (res.status === 429) {
        progressLabel.textContent = 'Rate limit LB, pause 10s…';
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (!res.ok) {
        errorStreak++;
        if (errorStreak > 5) { done = true; break; }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const data = await res.json();
      const listens = data.payload?.listens || [];
      errorStreak = 0;

      if (!listens.length) { done = true; break; }

      listens.forEach(listen => {
        const ts      = listen.listened_at || 0;
        const meta    = listen.track_metadata || {};
        const mbMap   = meta.mbid_mapping || {};
        const addInfo = meta.additional_info || {};

        const artist   = (meta.artist_name  || '').trim();
        const album    = (meta.release_name  || '').trim();
        const track    = (meta.track_name    || '').trim();
        const recMbid  = mbMap.recording_mbid  || addInfo.recording_mbid  || '';
        const relMbid  = mbMap.release_mbid    || addInfo.release_mbid    || '';

        if (ts > latestTs) latestTs = ts;
        // Pour sync complète : avancer vers le passé
        if (!isIncremental && (!maxTs || ts < maxTs)) maxTs = ts - 1;

        if (!artist) return;
        totalFetched++;

        // ── Index albums ────────────────────────────────────────────────
        // ListenBrainz n'incrémente plus jamais .plays (last.fm reste seul comptable) —
        // seul l'enrichissement MBID est appliqué, et uniquement sur une entrée déjà connue
        // de last.fm (sinon un scrobble vu par LB mais pas encore par last.fm resterait à 0
        // écoute de toute façon, inutile de créer une entrée fantôme).
        if (album) {
          const k = normalizeKey(artist, album);
          if (_lastfmCounts[k] && relMbid && !_lastfmCounts[k].release_mbid) { _lastfmCounts[k].release_mbid = relMbid; albumsMbidEnriched++; }

          // Matcher contre la collection (uniquement pour le MBID — jamais pour a.plays)
          let found = relMbid ? mbReleaseIndex.get(relMbid) : null;
          if (!found) {
            const aNorm = normalizeKey('', album).replace('|||','');
            for (const av of artistVariants(artist)) {
              found = albums.find(a => normalizeKey('',a.album).replace('|||','') === aNorm && artistVariants(a.artist).has(av));
              if (found) break;
            }
          }
          if (found && relMbid && !found.mb_release_id) { found.mb_release_id = relMbid; mbReleaseIndex.set(relMbid, found); }
        }

        // ── Index morceaux ──────────────────────────────────────────────
        // Idem : enrichissement MBID seul sur une entrée déjà comptée par la sync last.fm morceaux.
        if (track) {
          const kt = normalizeKey(artist, track) + '|' + normalizeKey('', album);
          if (_lastfmTrackCounts[kt]) {
            if (recMbid && !_lastfmTrackCounts[kt].recording_mbid) { _lastfmTrackCounts[kt].recording_mbid = recMbid; tracksMbidEnriched++; }
            if (relMbid && !_lastfmTrackCounts[kt].release_mbid)   _lastfmTrackCounts[kt].release_mbid   = relMbid;
          }
        }
      });

      // Sync incrémentale : une seule page (écoutes récentes triées desc)
      if (isIncremental || listens.length < 1000) { done = true; }

      // Progression
      const pct = totalListens > 0 ? Math.min(99, Math.round(totalFetched / totalListens * 100)) : 0;
      bar.style.width = pct + '%';
      progressLabel.textContent = `${totalFetched.toLocaleString('fr-FR')} / ${totalListens.toLocaleString('fr-FR')} écoutes parcourues — ${albumsMbidEnriched} album(s) + ${tracksMbidEnriched} morceau(x) enrichis en MBID`;

      // Checkpoint + flush Supabase toutes les 50 000 écoutes
      if (totalFetched > 0 && totalFetched % 50000 < 1000) {
        _saveLbCheckpoint(maxTs, totalFetched);
        progressLabel.textContent += ' — flush Supabase…';
        await _flushLbToSupabase(false);
      }

    } catch(e) {
      errorStreak++;
      progressLabel.textContent = `Erreur réseau (${errorStreak}/5), retry 3s…`;
      await new Promise(r => setTimeout(r, 3000));
      if (errorStreak > 5) { done = true; }
    }
  }

  // ── Finalisation ──────────────────────────────────────────────────────────
  lastfmData = Object.values(_lastfmCounts);

  if (_lbSyncAbort) {
    _saveLbCheckpoint(maxTs, totalFetched);
    status.textContent = `⏸ LB interrompu — ${totalFetched.toLocaleString('fr-FR')} écoutes traitées — checkpoint sauvegardé`;
    status.className = 'status ok';
  } else {
    if (latestTs > lastSyncTs) {
      localStorage.setItem(LB_SYNC_KEY, String(latestTs));
      if (window._sb) window._sb.from('meta').upsert({ key: 'lb_sync_ts', value: String(latestTs) }, { onConflict: 'key' }).then(() => {});
    }
    localStorage.removeItem('lb_checkpoint');
    bar.style.width = '100%';
    const matched = albums.filter(a => (a.plays || 0) > 0).length;
    status.textContent = `✓ LB ${isIncremental ? 'incrémental' : 'complet'} — ${totalFetched.toLocaleString('fr-FR')} écoutes parcourues · ${albumsMbidEnriched} album(s) + ${tracksMbidEnriched} morceau(x) enrichis en MBID (écoutes inchangées, source last.fm)`;
    status.className = 'status ok';
    toast(`🔵 LB : ${albumsMbidEnriched} album(s) + ${tracksMbidEnriched} morceau(x) enrichis en MBID`);
  }

  await _flushLbToSupabase(true);
  invalidateCache();
  updateNavBadges();
  renderAlbums();
  if (document.getElementById('sec-missing-tracks')?.classList.contains('active')) renderMissingTracks();

  progress.style.display = 'none';
  btn.textContent = '🔵 Sync ListenBrainz';
  _lbSyncRunning = false;
}

// ── Helpers ListenBrainz full sync ──────────────────────────────────────────
let _lbSyncRunning = false;
let _lbSyncAbort   = false;
const LB_SYNC_KEY  = 'lb_last_sync_ts';

function _saveLbCheckpoint(maxTs, totalFetched) {
  try {
    // Ne stocke plus que la position de pagination — les compteurs ne sont plus jamais restaurés
    // depuis le checkpoint (voir syncListenBrainz), inutile de dupliquer tout _lastfmCounts ici.
    localStorage.setItem('lb_checkpoint', JSON.stringify({ maxTs, totalFetched, savedAt: Date.now() }));
  } catch(e) { console.warn('LB checkpoint non sauvegardé:', e); }
}

async function _flushLbToSupabase(isFinal) {
  if (!window._sb) return;
  try {
    // lastfm_data (albums) — dédoublonnage par clé NORMALISÉE (voir saveToSupabase),
    // sinon ce flux réintroduit les mêmes doublons de casse qu'ailleurs.
    const dedupAlb = new Map();
    lastfmData.forEach(d => {
      if (!d.artist || !d.album) return;
      const k = normalizeKey(d.artist, d.album);
      const prev = dedupAlb.get(k);
      if (!prev) {
        dedupAlb.set(k, { artist: d.artist, album: d.album, plays: d.plays || 0, _best: d.plays || 0 });
      } else {
        prev.plays += (d.plays || 0);
        if ((d.plays || 0) > prev._best) { prev._best = d.plays || 0; prev.artist = d.artist; prev.album = d.album; }
      }
    });
    lastfmData = [...dedupAlb.values()].map(({ artist, album, plays }) => ({ artist, album, plays }));
    await sbUpsert('lastfm_data', lastfmData.map(d => ({
      artist: d.artist, album: d.album, plays: d.plays || 0, updated_at: new Date().toISOString()
    })), 'artist,album');

    // lastfm_tracks (morceaux)
    await flushTrackCountsToSupabase();

    if (isFinal) {
      // Enrichir mb_release_id dans albums[] Supabase
      const withMbid = albums.filter(a => a.mb_release_id);
      for (let i = 0; i < withMbid.length; i += 200) {
        const batch = withMbid.slice(i, i + 200);
        for (const a of batch) {
          await window._sb.from('albums').update({ mb_release_id: a.mb_release_id }).eq('id', a.id).then(() => {});
        }
      }
      saveToStorage();
    }
  } catch(e) { console.warn('_flushLbToSupabase:', e); }
}

function saveLastfmCheckpoint(currentPage, totalPages) {
  // Les compteurs (albums ET morceaux) sont désormais sécurisés régulièrement côté Supabase par
  // flushAlbumCountsToSupabase()/flushTrackCountsToSupabase() (appelées plus bas dans la boucle),
  // et rechargés en mémoire au démarrage de l'app. Le checkpoint local ne stocke donc plus qu'un
  // pointeur de reprise minuscule ({page, totalPages}) — avant ce fix, un compact des ~197k
  // morceaux (15-30 Mo une fois stringifié) saturait le quota localStorage à chaque appel, ce qui
  // faisait aussi échouer l'écriture — pourtant minuscule — du checkpoint albums juste après.
  try {
    localStorage.setItem(LASTFM_CHECKPOINT_KEY, JSON.stringify({ page: currentPage, totalPages, savedAt: Date.now() }));
  } catch(e) { console.warn('Checkpoint last.fm non sauvegardé :', e); }
  // Nettoyage d'un éventuel ancien checkpoint morceaux volumineux laissé par une version antérieure
  localStorage.removeItem(LASTFM_TRACK_CHECKPOINT_KEY);
}

function loadLastfmCheckpoint() {
  try {
    const raw = localStorage.getItem(LASTFM_CHECKPOINT_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw);
    if (Date.now() - cp.savedAt > 48 * 3600 * 1000) {
      localStorage.removeItem(LASTFM_CHECKPOINT_KEY);
      localStorage.removeItem(LASTFM_TRACK_CHECKPOINT_KEY);
      return null;
    }
    return cp;
  } catch(e) { return null; }
}

function clearLastfmCheckpoint() {
  localStorage.removeItem(LASTFM_CHECKPOINT_KEY);
  localStorage.removeItem(LASTFM_TRACK_CHECKPOINT_KEY);
}

// Flush partiel vers Supabase — appelé toutes les 50 pages et en fin de sync
async function flushTrackCountsToSupabase() {
  if (!window._sb || !Object.keys(_lastfmTrackCounts).length) return;
  try {
    const rows = Object.values(_lastfmTrackCounts).map(d => ({
      artist: d.artist, track: d.track, album: d.album || '',
      plays: d.plays, updated_at: new Date().toISOString()
    }));
    // Upsert par tranches de 400 — clé (artist, track, album)
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await window._sb.from('lastfm_tracks')
        .upsert(rows.slice(i, i + 400), { onConflict: 'artist,track,album' });
      if (error) console.warn('flush chunk error:', error);
    }
    console.log(`lastfm_tracks : ${rows.length} morceaux sauvegardés dans Supabase`);
  } catch(e) { console.warn('Erreur flush lastfm_tracks:', e); }
}

// Même principe côté albums — avant ce fix, seul flushTrackCountsToSupabase() existait : les
// morceaux étaient sécurisés régulièrement pendant la sync, mais les albums (_lastfmCounts)
// n'étaient écrits dans Supabase qu'à la toute fin (saveToStorage), donc perdus en cas de crash
// ou de fermeture d'onglet en cours de route.
async function flushAlbumCountsToSupabase() {
  if (!window._sb || !Object.keys(_lastfmCounts).length) return;
  try {
    const rows = Object.values(_lastfmCounts).map(d => ({
      artist: d.artist, album: d.album, plays: d.plays || 0, updated_at: new Date().toISOString()
    }));
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await window._sb.from('lastfm_data')
        .upsert(rows.slice(i, i + 400), { onConflict: 'artist,album' });
      if (error) console.warn('flush chunk error (albums):', error);
    }
    console.log(`lastfm_data : ${rows.length} albums sauvegardés dans Supabase`);
  } catch(e) { console.warn('Erreur flush lastfm_data:', e); }
}

async function fetchLastfmPage(page) {
  const status = document.getElementById('status-lastfm');
  const progress = document.getElementById('lastfm-progress');
  const bar = document.getElementById('lastfm-bar');
  const progressLabel = document.getElementById('lastfm-progress-label');
  const btnMore = document.getElementById('btn-lastfm-more');

  progress.style.display = 'block';
  btnMore.style.display = 'inline-flex';
  btnMore.textContent = '⏸ Pause';
  _lastfmAbort = false;

  // Vérifier si un checkpoint existe pour reprendre
  const checkpoint = loadLastfmCheckpoint();
  let currentPage = page;
  if (checkpoint && checkpoint.page > page && checkpoint.totalPages === _lastfmTotalPages) {
    // Reprendre depuis le checkpoint — les compteurs eux-mêmes viennent de lastfmData (déjà en
    // mémoire, rechargé depuis Supabase au démarrage / mis à jour par les flushs périodiques),
    // plus jamais d'un blob stocké dans le checkpoint local (voir saveLastfmCheckpoint).
    currentPage = checkpoint.page;
    _lastfmCounts = {};
    lastfmData.forEach(d => { _lastfmCounts[normalizeKey(d.artist, d.album)] = { artist: d.artist, album: d.album, plays: d.plays || 0 }; });
    progressLabel.textContent = `Reprise depuis la page ${currentPage} (checkpoint trouvé)`;
  }

  let errorStreak = 0; // compteur d'erreurs consécutives

  while (currentPage <= _lastfmTotalPages && !_lastfmAbort) {
    try {
      const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=${LASTFM_PAGE_SIZE}&page=${currentPage}&extended=0`;
      const res = await fetch(url);

      if (res.status === 429) {
        progressLabel.textContent = `Limite API, pause 15s… (page ${currentPage}/${_lastfmTotalPages})`;
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }

      const data = await res.json();

      if (data.error) {
        if (data.error === 11 || data.error === 16) {
          // Erreur temporaire serveur last.fm — attendre et réessayer
          errorStreak++;
          const wait = Math.min(30000, 5000 * errorStreak);
          progressLabel.textContent = `Serveur last.fm indisponible (erreur ${data.error}), pause ${wait/1000}s… (page ${currentPage})`;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        // Erreur fatale — sauvegarder le checkpoint et s'arrêter
        saveLastfmCheckpoint(currentPage, _lastfmTotalPages);
        status.textContent = `⚠️ Erreur last.fm : ${data.message} — checkpoint sauvegardé à la page ${currentPage}`;
        status.className = 'status err';
        progress.style.display = 'none';
        btnMore.textContent = '▶ Reprendre';
        btnMore.style.display = 'inline-flex';
        return;
      }

      errorStreak = 0; // reset streak en cas de succès

      const tracks = data.recenttracks?.track || [];
      _lastfmTotalPages = parseInt(data.recenttracks?.['@attr']?.totalPages || _lastfmTotalPages);
      _lastfmCurrentPage = parseInt(data.recenttracks?.['@attr']?.page || currentPage);
      const totalTracks = parseInt(data.recenttracks?.['@attr']?.total || 0);

      tracks.forEach(t => {
        if (t['@attr']?.nowplaying) return;
        const artist = String(t.artist?.['#text'] || t.artist?.name || t.artist || '').trim();
        const album  = String(t.album?.['#text']  || t.album?.name  || (typeof t.album === 'string' ? t.album : '')  || '').trim();
        const track  = String(t.name || '').trim();
        const ts = parseInt(t.date?.uts || 0);
        if (!artist) return;
        // Index albums
        if (album) {
          const k = normalizeKey(artist, album);
          if (!_lastfmCounts[k]) _lastfmCounts[k] = { artist, album, plays: 0 };
          _lastfmCounts[k].plays++;
        }
        // Index morceaux (track + album)
        if (track) {
          const kt = normalizeKey(artist, track) + '|' + normalizeKey('', album);
          if (!_lastfmTrackCounts[kt]) _lastfmTrackCounts[kt] = { artist, track, album: album || '', plays: 0 };
          _lastfmTrackCounts[kt].plays++;
        }
      });

      const pct = Math.round((currentPage / _lastfmTotalPages) * 100);
      bar.style.width = pct + '%';
      const scrobblesLoaded = Math.min(currentPage * LASTFM_PAGE_SIZE, totalTracks);
      const nTracks = Object.keys(_lastfmTrackCounts).length;
      progressLabel.textContent = `Page ${currentPage}/${_lastfmTotalPages} — ${scrobblesLoaded.toLocaleString('fr-FR')} / ${totalTracks.toLocaleString('fr-FR')} scrobbles — ${Object.keys(_lastfmCounts).length} albums · ${nTracks.toLocaleString('fr-FR')} morceaux`;

      // Checkpoint albums + tracks toutes les 10 pages
      if (currentPage % 10 === 0) {
        lastfmData = Object.values(_lastfmCounts);
        applyLastfmPlaysToAlbums(lastfmData);
        saveLastfmCheckpoint(currentPage + 1, _lastfmTotalPages);
        updateNavBadges();
      }
      // Flush Supabase toutes les 50 pages (sauvegarde partielle albums + morceaux)
      if (currentPage % 50 === 0) {
        progressLabel.textContent += ' — sauvegarde partielle…';
        await flushTrackCountsToSupabase();
        await flushAlbumCountsToSupabase();
      }

      currentPage++;
      _lastfmCurrentPage = currentPage;

      await new Promise(r => setTimeout(r, 220));

    } catch(e) {
      // Erreur réseau — sauvegarder checkpoint et réessayer
      errorStreak++;
      saveLastfmCheckpoint(currentPage, _lastfmTotalPages);
      const wait = Math.min(15000, 3000 * errorStreak);
      progressLabel.textContent = `Erreur réseau, nouvelle tentative dans ${wait/1000}s… (page ${currentPage}) — checkpoint sauvegardé`;
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // Terminé ou pause
  lastfmData = Object.values(_lastfmCounts);
  applyLastfmPlaysToAlbums(lastfmData);

  if (_lastfmAbort) {
    saveLastfmCheckpoint(currentPage, _lastfmTotalPages);
    progressLabel.textContent = 'Sauvegarde avant pause…';
    await flushTrackCountsToSupabase();
    await flushAlbumCountsToSupabase();
    status.textContent = `⏸ Mis en pause à la page ${currentPage - 1}/${_lastfmTotalPages} — ${lastfmData.length} albums — checkpoint sauvegardé`;
    status.className = 'status ok';
    btnMore.textContent = '▶ Reprendre';
    btnMore.style.display = 'inline-flex';
  } else {
    // Flush final des albums + morceaux dans Supabase
    progressLabel.textContent = 'Sauvegarde des albums et morceaux dans Supabase…';
    await flushTrackCountsToSupabase();
    await flushAlbumCountsToSupabase();
    clearLastfmCheckpoint();
    const syncTs = String(Math.floor(Date.now() / 1000));
    localStorage.setItem(LASTFM_SYNC_KEY, syncTs);
    updateLastSyncLabel();
    if (window._sb) {
      window._sb.from('meta').upsert({ key: 'lastfm_sync_ts', value: syncTs }, { onConflict: 'key' }).then(() => {});
    }
    const nT = Object.keys(_lastfmTrackCounts).length;
    status.textContent = `✓ Complet — ${lastfmData.length} albums · ${nT.toLocaleString('fr-FR')} morceaux distincts`;
    status.className = 'status ok';
    bar.style.width = '100%';
    progress.style.display = 'none';
    btnMore.style.display = 'none';
    toast(`last.fm : ${lastfmData.length} albums · ${nT.toLocaleString('fr-FR')} morceaux synchronisés`);
  }

  renderAlbums();
  updateNavBadges();
  saveToStorage();
}

async function loadMoreLastfm() {
  if (_lastfmAbort) {
    _lastfmAbort = false;
    document.getElementById('btn-lastfm-more').style.display = 'none';
    // Reprendre depuis le checkpoint si disponible, sinon depuis la page courante
    const cp = loadLastfmCheckpoint();
    if (cp) {
      _lastfmCounts = {};
      lastfmData.forEach(d => { _lastfmCounts[normalizeKey(d.artist, d.album)] = { artist: d.artist, album: d.album, plays: d.plays || 0 }; });
      _lastfmTotalPages = cp.totalPages;
      await fetchLastfmPage(cp.page);
    } else {
      await fetchLastfmPage(_lastfmCurrentPage);
    }
  } else {
    _lastfmAbort = true;
  }
}


// ===================== ALBUM TRACKS =====================
let albumTracksCache = {}; // { albumId: [{ position, title, duration, source }] }

function getDiscogsToken() {
  return (document.getElementById('discogs-token')?.value || localStorage.getItem('discogs_token') || '').trim();
}

// Formater la durée en mm:ss depuis millisecondes (MusicBee) ou string Discogs
function formatDuration(val) {
  if (!val) return '';
  if (typeof val === 'number') {
    const s = Math.round(val / 1000);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }
  return String(val);
}

// Appeler l'Edge Function (proxy sans CORS)
async function callEdgeFn(params) {
  const anonKey = localStorage.getItem('supabase_anon_key') || '';
  const url = EDGE_FN_URL + '?' + new URLSearchParams(params).toString();
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${anonKey}`,
      'apikey': anonKey,
    }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// Récupérer tracklist + infos Discogs via Edge Function
async function fetchDiscogsRelease(discogsId) {
  const data = await callEdgeFn({ source: 'discogs', release_id: discogsId });
  return {
    tracklist: (data.tracklist || []).map(t => ({ ...t, source: 'discogs' })),
    release_date: data.release_date || '',
    master_year: data.master_year || '', // année d'édition originale (master release Discogs) — 2e source, à croiser avec mb_original_year
    cover_url: data.cover_url || '',
    genres: data.genres || [],
    styles: data.styles || [],
    label: data.label || '',
    country: data.country || '',
  };
}

// Récupérer les stats marketplace Discogs (prix le plus bas, nb en vente) via Edge Function —
// endpoint séparé de /releases/{id}, cf. get-release-info.ts branche "discogs_stats".
async function fetchMarketplaceStats(discogsId) {
  const data = await callEdgeFn({ source: 'discogs_stats', release_id: discogsId, curr_abbr: 'EUR' });
  return {
    price: data.lowest_price ?? null,
    currency: data.currency || 'EUR',
    numForSale: data.num_for_sale || 0,
  };
}


// Rechercher sur MusicBrainz via Edge Function (par artiste+album)
async function searchMusicBrainz(artist, album) {
  const data = await callEdgeFn({ source: 'musicbrainz', artist, album });
  return data.results || []; // [{ mb_release_id, score, title, artist, release_date, cover_url, ... }]
}

// Rechercher sur Discogs via Edge Function (v2026.07.12-18 — nécessite le déploiement de la
// branche "discogs_search" de get-release-info.ts, DISCOGS_TOKEN déjà configuré côté serveur).
async function searchDiscogs(artist, album) {
  const data = await callEdgeFn({ source: 'discogs_search', artist, album });
  return data.results || []; // [{ id, title, year, format, label, country, thumb }]
}

// Récupérer tracklist MusicBrainz par ID via Edge Function
async function fetchMusicBrainzRelease(mbId) {
  const data = await callEdgeFn({ source: 'musicbrainz', mb_id: mbId });
  return {
    tracklist: (data.tracklist || []).map(t => ({ ...t, source: 'musicbrainz' })),
    release_date: data.release_date || '',
    first_release_date: data.first_release_date || '', // année d'origine (release-group MB)
    genres: data.genres || [],                          // genres du release-group, triés par pertinence
    release_type: data.release_type || '',               // primary-type release-group : Album/EP/Single/Broadcast/Other
    release_secondary_types: data.release_secondary_types || [], // Compilation/Live/Remix/Soundtrack/...
    credits: data.credits || [],                          // crédits release (producteur, ingénieur, mixage...) — [{role, name}]
    youtube_url: data.youtube_url || '',                 // lien direct si un éditeur MB l'a renseigné
    cover_url: data.cover_url || '',
    label: data.label || '',
    country: data.country || '',
    mb_release_id: data.mb_release_id || '',
  };
}

// Sauvegarder tracklist dans Supabase
async function saveTracklist(albumId, tracks_) {
  if (!window._sb || !tracks_.length) return;
  const source = tracks_[0]?.source || 'discogs';
  try {
    await window._sb.from('album_tracks').delete()
      .eq('album_id', albumId).eq('source', source);
  } catch(e) {
    console.warn('saveTracklist delete (ignoré):', e.message || e);
    albumTracksCache[albumId] = (albumTracksCache[albumId] || [])
      .filter(t => t.source !== source).concat(tracks_);
    return;
  }
  const seen = new Set();
  const unique = tracks_.filter(t => {
    const k = (t.title||'').toLowerCase().trim() + '|' + (t.position||'');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const rows = unique.map(t => ({
    album_id:        String(albumId), // toujours text désormais
    position:        t.position||'',
    title:           t.title||'',
    duration:        t.duration||'',
    source:          t.source,
    bitrate:         t.bitrate||null,
    sample_rate:     t.sample_rate||null,
    file_size:       t.file_size||null,
    play_count:      t.play_count||null,
    last_played:     t.last_played||null,
    date_added:      t.date_added||null,
    composer:        t.composer||null,
    isrc:            t.isrc||null,
    mb_recording_id: t.mb_recording_id||null,
    disc_number:     t.disc_number||null,
    rating:          t.rating||null,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await window._sb.from('album_tracks').insert(rows.slice(i, i + 100));
    if (error) console.warn('saveTracklist error:', error.message);
  }
  albumTracksCache[albumId] = (albumTracksCache[albumId] || [])
    .filter(t => t.source !== source).concat(tracks_);
}

// ===================== PROVENANCE DES CHAMPS =====================
// Todo section 2 : year/genre/cover_url/label sont remplis au fil de l'eau par
// plusieurs sources sans traçabilité. field_provenance = { [champ]: { source, synced_at } }
// distingue une valeur manuelle (jamais écrasée par un import/enrichissement auto)
// d'une valeur auto (rafraîchissable, avec indicateur de fraîcheur).
const PROVENANCE_FIELDS = ['year', 'genre', 'artist', 'cover_url', 'label'];
const PROVENANCE_SOURCE_LABELS = {
  manual:      'Manuel',
  discogs:     'Discogs',
  musicbrainz: 'MusicBrainz',
  musicbee:    'MusicBee',
  lastfm:      'Last.fm',
  rym:         'RYM',
};

// Enregistre la source/date d'une valeur auto.
function setProvenance(album, field, source) {
  if (!album.field_provenance) album.field_provenance = {};
  album.field_provenance[field] = { source, synced_at: new Date().toISOString() };
}
// Un champ verrouillé manuellement n'est plus jamais écrasé par les patterns
// auto "if (!album.x) album.x = ..." (MusicBrainz, Discogs, Last.fm, imports CSV génériques).
// Les imports authoritatifs existants (Discogs CSV → year, MusicBee XML → year/genre,
// décision volontaire antérieure pour ne pas rester bloqué sur une valeur périmée)
// restent inchangés et continuent d'écraser même un champ verrouillé.
function isManualField(album, field) {
  return album.field_provenance?.[field]?.source === 'manual';
}
// Reporte la provenance d'un champ lors d'une fusion manuelle de fiches (mergeAlbumsManual)
function carryProvenance(tgt, src, field) {
  const p = src.field_provenance?.[field];
  if (!p) return;
  if (!tgt.field_provenance) tgt.field_provenance = {};
  tgt.field_provenance[field] = { ...p };
}
function formatProvenanceAge(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 30) return `il y a ${days}j`;
  const months = Math.floor(days / 30);
  if (months < 12) return `il y a ${months} mois`;
  return `il y a ${Math.floor(months / 12)} an(s)`;
}

// Appliquer l'enrichissement MusicBrainz (année d'origine + genre) à un album,
// sans jamais écraser `year` — mb_original_year reste une info de référence à côté.
function applyMbEnrichment(album, rel) {
  let changed = false;
  if (rel.first_release_date) {
    const origYear = rel.first_release_date.slice(0, 4);
    if (origYear && String(album.mb_original_year || '') !== origYear) {
      album.mb_original_year = origYear;
      changed = true;
    }
  }
  if (!album.genre && rel.genres?.length && !isManualField(album, 'genre')) {
    album.genre = rel.genres[0];
    setProvenance(album, 'genre', 'musicbrainz');
    changed = true;
  }
  if (rel.youtube_url && album.youtube_url !== rel.youtube_url) {
    album.youtube_url = rel.youtube_url;
    changed = true;
  }
  // Type de release-group (todo section 6, item ⬜) : simple champ informatif, jamais
  // édité manuellement contrairement à year/genre/label/cover_url — pas besoin de
  // field_provenance/verrou, toujours rafraîchi si la valeur change.
  if (rel.release_type && album.mb_release_type !== rel.release_type) {
    album.mb_release_type = rel.release_type;
    changed = true;
  }
  const secTypes = rel.release_secondary_types || [];
  if (JSON.stringify(secTypes) !== JSON.stringify(album.mb_release_secondary_types || [])) {
    album.mb_release_secondary_types = secTypes;
    changed = true;
  }
  // Crédits MusicBrainz (todo section 6, item ⬜) : producteur/ingénieur/mixage/arrangement
  // posés au niveau release. Simple champ informatif comme le type de release-group —
  // pas de field_provenance/verrou, toujours rafraîchi si la liste change.
  const credits = rel.credits || [];
  if (JSON.stringify(credits) !== JSON.stringify(album.mb_credits || [])) {
    album.mb_credits = credits;
    changed = true;
  }
  if (changed) saveToStorage();
}

// Rafraîchir uniquement année d'origine + genre pour tous les albums ayant déjà un
// mb_release_id — sans toucher aux tracklists déjà en cache (contrairement à
// fetchAllTracklists qui, lui, saute les albums déjà traités via onlyMissing).
// Utile en backfill après ajout du champ mb_original_year sur des albums déjà enrichis.
const MB_REFRESH_STALE_DAYS = 30; // seuil avant re-rafraîchissement automatique d'un album déjà traité

async function refreshMbYearGenres(force = false) {
  const btn    = document.getElementById('btn-refresh-mb-year-genre');
  const status = document.getElementById('status-mb-year-genre');
  const withMb = albums.filter(a => a.mb_release_id);

  if (!status) return;
  if (!withMb.length) {
    status.textContent = 'Aucun album avec un ID MusicBrainz.';
    status.className = 'status ok';
    return;
  }

  const staleMs = MB_REFRESH_STALE_DAYS * 86400000;
  const now = Date.now();
  const targets = force ? withMb : withMb.filter(a => !a.mb_refreshed_at || (now - new Date(a.mb_refreshed_at).getTime()) > staleMs);
  const skipped = withMb.length - targets.length;

  if (!targets.length) {
    status.textContent = `Rien à rafraîchir — ${withMb.length} album(s) déjà à jour (< ${MB_REFRESH_STALE_DAYS }j). Reforcer via le bouton "tout".`;
    status.className = 'status ok';
    return;
  }

  if (btn) btn.disabled = true;
  status.className = 'status';
  let done = 0, updated = 0, errors = 0;

  for (const album of targets) {
    status.textContent = `MusicBrainz ${done}/${targets.length}${skipped ? ` (${skipped} déjà à jour, ignorés)` : ''} — ${album.artist} — ${album.album}`;
    try {
      await new Promise(r => setTimeout(r, 1200)); // MusicBrainz rate limit 1/s + marge Edge Fn
      const rel = await fetchMusicBrainzRelease(album.mb_release_id);
      const beforeYear  = album.mb_original_year;
      const beforeGenre = album.genre;
      const beforeYoutube = album.youtube_url;
      applyMbEnrichment(album, rel);
      album.mb_refreshed_at = new Date().toISOString();
      if (album.mb_original_year !== beforeYear || album.genre !== beforeGenre || album.youtube_url !== beforeYoutube) updated++;
      done++;
    } catch(e) {
      console.warn(`Rafraîchissement MB ${album.mb_release_id}:`, e.message);
      errors++;
    }
  }

  if (btn) btn.disabled = false;
  status.textContent = `Terminé : ${updated} album(s) mis à jour sur ${targets.length}${skipped ? ` (+ ${skipped} déjà à jour, ignorés)` : ''}${errors ? `, ${errors} erreur(s)` : ''}.`;
  status.className = errors ? 'status err' : 'status ok';
  saveToStorage();
  renderAlbums(); renderDiscographie();
}

// Charger toutes les tracklists (Discogs + MusicBrainz) via Edge Function
async function fetchAllTracklists(onlyMissing = true) {
  const btn    = document.getElementById('btn-fetch-tracklists');
  const status = document.getElementById('status-tracklists');

  if (!btn || !status) return;

  // Albums avec Discogs ID (priorité)
  const discogsTargets = albums.filter(a =>
    a.discogsId && (!onlyMissing || !albumTracksCache[a.id]?.some(t => t.source === 'discogs'))
  );
  // Albums sans Discogs ID mais sans tracklist MusicBrainz non plus
  const mbTargets = albums.filter(a =>
    !a.discogsId && (!onlyMissing || !albumTracksCache[a.id]?.some(t => t.source === 'musicbrainz'))
  );

  const total = discogsTargets.length + mbTargets.length;
  if (!total) {
    status.textContent = 'Toutes les tracklists sont à jour.';
    status.className = 'status ok';
    return;
  }

  btn.disabled = true;
  status.className = 'status';
  let done = 0, errors = 0;

  // ── Discogs ──
  for (const album of discogsTargets) {
    status.textContent = `Discogs ${done}/${total} — ${album.artist} — ${album.album}`;
    try {
      await new Promise(r => setTimeout(r, 700)); // Edge Fn rate limit Discogs
      const rel = await fetchDiscogsRelease(album.discogsId);
      if (rel.tracklist.length) {
        albumTracksCache[album.id] = (albumTracksCache[album.id] || [])
          .filter(t => t.source !== 'discogs').concat(rel.tracklist);
        await saveTracklist(album.id, rel.tracklist);
      }
      // Enrichir l'album avec les infos Discogs
      let changed = false;
      if (!album.release_date && rel.release_date) { album.release_date = rel.release_date; changed = true; }
      if (!album.cover_url && rel.cover_url && !rel.cover_url.includes('coverartarchive') && !isManualField(album, 'cover_url')) { album.cover_url = rel.cover_url; setProvenance(album, 'cover_url', 'discogs'); changed = true; }
      if (!album.genre && rel.genres?.length && !isManualField(album, 'genre'))      { album.genre = rel.genres[0]; setProvenance(album, 'genre', 'discogs'); changed = true; }
      if (rel.master_year && album.discogs_master_year !== rel.master_year) { album.discogs_master_year = rel.master_year; changed = true; }
      if (changed) saveToStorage();
      done++;
    } catch(e) {
      console.warn(`Discogs ${album.discogsId}:`, e.message);
      errors++;
    }
  }

  // ── MusicBrainz (albums sans Discogs ID) ──
  for (const album of mbTargets) {
    status.textContent = `MusicBrainz ${done}/${total} — ${album.artist} — ${album.album}`;
    try {
      await new Promise(r => setTimeout(r, 1200)); // MusicBrainz rate limit 1/s + marge Edge Fn
      // Si l'album a déjà un mb_release_id, lookup direct
      if (album.mb_release_id) {
        const rel = await fetchMusicBrainzRelease(album.mb_release_id);
        if (rel.tracklist.length) {
          albumTracksCache[album.id] = (albumTracksCache[album.id] || [])
            .filter(t => t.source !== 'musicbrainz').concat(rel.tracklist);
          await saveTracklist(album.id, rel.tracklist);
        }
        if (!album.release_date && rel.release_date) { album.release_date = rel.release_date; saveToStorage(); }
        if (!album.cover_url && rel.cover_url && !rel.cover_url.includes('coverartarchive') && !isManualField(album, 'cover_url')) { album.cover_url = rel.cover_url; setProvenance(album, 'cover_url', 'musicbrainz'); saveToStorage(); }
        applyMbEnrichment(album, rel);
      } else {
        // Recherche — nettoyer le nom Discogs avant MusicBrainz
        const cleanArtist = cleanDiscogsArtist(album.artist);
        const results = await searchMusicBrainz(cleanArtist, album.album);
        const best = results[0];
        if (best && best.score >= 90) {
          album.mb_release_id = best.mb_release_id;
          album.mb_match_score = best.score; // conservé pour revalidation ultérieure (score de confiance visible)
          if (!album.release_date && best.release_date) album.release_date = best.release_date;
          if (!album.cover_url && best.cover_url && !best.cover_url.includes('coverartarchive') && !isManualField(album, 'cover_url')) { album.cover_url = best.cover_url; setProvenance(album, 'cover_url', 'musicbrainz'); }
          saveToStorage();
          // 2e appel pour la tracklist complète
          await new Promise(r => setTimeout(r, 1200));
          const rel = await fetchMusicBrainzRelease(best.mb_release_id);
          if (rel.tracklist.length) {
            albumTracksCache[album.id] = (albumTracksCache[album.id] || [])
              .filter(t => t.source !== 'musicbrainz').concat(rel.tracklist);
            await saveTracklist(album.id, rel.tracklist);
          }
          applyMbEnrichment(album, rel);
        }
      }
      done++;
    } catch(e) {
      console.warn(`MusicBrainz ${album.artist} — ${album.album}:`, e.message);
      errors++;
    }
  }

  btn.disabled = false;
  status.textContent = `✓ ${done} tracklists chargées (Discogs: ${discogsTargets.length}, MusicBrainz: ${mbTargets.length})${errors ? ' — ' + errors + ' erreurs' : ''}`;
  status.className = 'status ok';
  toast(`Tracklists : ${done} albums mis à jour`);
  
  invalidateCache();
  renderDiscographie();
}

function importMusicBeeTracklists(trackDicts, str, num, dateStr, isolatedTracksArg) {
  // ── Collecter TOUTES les pistes depuis le XML, indépendamment du dossier ─────
  // Seule exclusion : blind-test (pas de la musique possédée)
  // Stock, ok, à vendre, discographie, top titres → tout indexé dans musicbee_tracks
  const byKey = {}; // normalizeKey(artist, album) → { artist, album, tracks[], folder }

  trackDicts.forEach(d => {
    const locationRaw = str(d, 'Location');
    // Location est une URL encodée (ex: "top%20titres") — la décoder avant tout test
    // de regex/inclusion, sinon "top%20titres" ne matche jamais "/top.?ti/i" (écart de 3
    // caractères pour %20, la regex n'en autorise qu'un seul), et le dossier reste 'album'.
    let location = locationRaw;
    try { location = decodeURIComponent(locationRaw); } catch(e) { /* URI malformée, garder brut */ }
    const locationLow = location.toLowerCase();
    if (locationLow.includes('blind-test') || locationLow.includes('blind_test')) return;

    const name      = str(d, 'Name');
    if (!name) return;

    const albumArtist = str(d, 'Album Artist');
    const artist_     = str(d, 'Artist');
    const isCompilTag = str(d, 'Compilation') === 'true' || str(d, 'Compilation') === '1';
    const isCompilation = isCompilTag || albumArtist === 'Various Artists';
    const artist = isCompilation ? 'Various Artists' : (albumArtist || artist_ || '');
    const album  = str(d, 'Album') || '';
	// Détecter le dossier pour annoter (informatif seulement)
    const pathParts = location.replace(/\\/g, '/').split('/');
    let folder = 'album';
    if (locationLow.includes('!_00_stock'))                                           folder = 'stock';
    else if (pathParts.some(p => /top.?ti/i.test(p) || /top.?track/i.test(p)))       folder = 'isolated';
    else if (pathParts.some(s => s === 'ok' || s === 'ok '))                          folder = 'ok';
    else if (pathParts.some(s => /^!?a.?vendre$/i.test(s) || s === '!vendre'))        folder = 'forsale';

    // Clé : si pas d'album (morceau isolé sans tag album), regrouper par artiste + titre
    const groupArtist = artist || artist_;
    const groupAlbum  = album  || `__isolated__${name}`;
    if (!groupArtist && !groupAlbum) return;

    const key = normalizeKey(groupArtist, groupAlbum);
    if (!byKey[key]) {
      const mbidAlbum_ = str(d, 'MBID Album');
      byKey[key] = { artist: groupArtist, album, tracks: [], mbReleaseId: mbidAlbum_ || '', folder };
    }

    byKey[key].tracks.push({
      position:        String(num(d, 'Track Number') || ''),
      title:           name,
      duration:        formatDuration(num(d, 'Total Time')),
      source:          'musicbee',
      folder,
      trackArtist:     artist_ || null,  // artiste individuel (≠ Album Artist pour compilations)
      bitrate:         num(d, 'Bit Rate')    || null,
      sample_rate:     num(d, 'Sample Rate') || null,
      file_size:       num(d, 'Size')        || null,
      play_count:      num(d, 'Play Count')  || null,
      last_played:     dateStr ? dateStr(d, 'Last Played') || null : null,
      date_added:      dateStr ? dateStr(d, 'Date Added')  || null : null,
      composer:        str(d, 'Composer')    || null,
          mb_recording_id: str(d, 'MusicBrainz Recording Id')
                    || str(d, 'MusicBrainz Track Id')
                    || str(d, 'MBID Track')
                    || str(d, 'MUSICBRAINZ_TRACKID')
                    || null,
      disc_number:     num(d, 'Disc Number') || null,
      rating:          (() => { const r = num(d, 'Rating'); return r ? Math.round(r / 20) : 0; })(),
    });
  });

  // Trier les pistes de chaque album
  Object.values(byKey).forEach(g => {
    g.tracks.sort((a, b) => {
      const da = a.disc_number || 1, db = b.disc_number || 1;
      if (da !== db) return da - db;
      return (parseInt(a.position) || 999) - (parseInt(b.position) || 999);
    });
  });

  // ── Stocker dans _albumTracksByKey (cache en mémoire) ────────────────────────
  window._albumTracksByKey = byKey;

  // ── Peupler _mbTrackKeys : Set des clés normalisées ──────────────────────────
  // Source de vérité pour computeMissingTracks — couvre TOUS les dossiers
  window._mbTrackKeys = new Set();
  Object.values(byKey).forEach(g => {
    g.tracks.forEach(t => {
      if (!t.title) return;
      const artist = g.artist;
      const clean  = cleanDiscogsArtist(artist);
      const noThe  = artist.replace(/^The\s+/i, '').replace(/^A\s+/i, '');
      // Pour chaque variante d'artiste (Album Artist), ajouter toutes les variantes de titre
      for (const art of [artist, clean, noThe]) {
        for (const k of normalizeKeyLoose(art, t.title)) {
          window._mbTrackKeys.add(k);
        }
      }
      // Indexer aussi avec l'artiste individuel (crucial pour compilations)
      // ex: Album Artist = "Various Artists", Artist = "Stéphane Grappelli"
      if (t.trackArtist && t.trackArtist !== artist) {
        const tClean = cleanDiscogsArtist(t.trackArtist);
        const tNoThe = t.trackArtist.replace(/^The\s+/i, '').replace(/^A\s+/i, '');
        for (const art of [t.trackArtist, tClean, tNoThe]) {
          for (const k of normalizeKeyLoose(art, t.title)) {
            window._mbTrackKeys.add(k);
          }
        }
      }
    });
  });
  const totalTracks = Object.values(byKey).reduce((s, g) => s + g.tracks.length, 0);
  const byFolder = Object.values(byKey).reduce((acc, g) => {
    acc[g.folder] = (acc[g.folder]||0) + g.tracks.length; return acc;
  }, {});
  console.log(`_mbTrackKeys : ${window._mbTrackKeys.size} clés pour ${totalTracks} pistes`, byFolder);

  // ── Tenter aussi le matching albums[] + stockItems[] pour albumTracksCache ─
  // Les albums en stock ont aussi leurs pistes dans byKey — il faut les indexer
  const albumIndex = new Map();
  const _indexIntoAlbumIndex = (a) => {
    const albumNorm = normalizeKey('', a.album).replace('|||', '');
    albumIndex.set(normalizeKey(a.artist, a.album), a);
    for (const av of artistVariants(a.artist)) {
      const k = av + '|||' + albumNorm;
      if (!albumIndex.has(k)) albumIndex.set(k, a);
    }
    if (a.mb_release_id) albumIndex.set('mbid:' + a.mb_release_id, a);
  };
  albums.forEach(a => _indexIntoAlbumIndex(a));
  stockItems.forEach(s => _indexIntoAlbumIndex(s));

  const toSave = [];
  let matched = 0, unmatched = 0;
  const unmatchedSample = [];
  Object.values(byKey).forEach(g => {
    if (!g.album || g.album.startsWith('__isolated__')) return;
    // Pistes "top titres" (singles téléchargés) : ont souvent un tag Album rempli
    // (ex: "21" pour "Rolling in the Deep") mais ne représentent pas un album possédé —
    // les compter comme "non matchés" n'a pas de sens et pollue le log.
    if (g.folder === 'isolated') return;
    const albumNorm = normalizeKey('', g.album).replace('|||', '');
    let albumObj = albumIndex.get(normalizeKey(g.artist, g.album));
    if (!albumObj) {
      for (const av of artistVariants(g.artist)) {
        albumObj = albumIndex.get(av + '|||' + albumNorm);
        if (albumObj) break;
      }
    }
    if (!albumObj && g.mbReleaseId) albumObj = albumIndex.get('mbid:' + g.mbReleaseId);


    if (albumObj) {
      albumTracksCache[albumObj.id] = (albumTracksCache[albumObj.id] || [])
        .filter(t => t.source !== 'musicbee').concat(g.tracks);
      toSave.push({ albumId: albumObj.id, tracks: g.tracks });
      matched++;
    } else {
      unmatched++;
      if (unmatchedSample.length < 20) unmatchedSample.push(`"${g.artist}" — "${g.album}"`);
    }
  });
  if (unmatchedSample.length) console.log('importMusicBeeTracklists — ' + unmatched + ' non matchés :\n' + unmatchedSample.join('\n'));
  // ── Sauvegarder dans Supabase en arrière-plan ────────────────────────────────
  // 1. album_tracks (inchangé — pour la vue Discographie)
  if (window._sb && toSave.length) {
    (async () => {
      for (const { albumId, tracks: tl } of toSave) {
        await saveTracklist(albumId, tl);
      }
    })();
  }

  // 2. musicbee_tracks — table dédiée, indexée par (artist_norm, title_norm)
  //    Flush complet en arrière-plan
  if (window._sb) {
    saveMusicBeeTracks(byKey);
  }

  console.log(`importMusicBeeTracklists : ${matched} matchés dans albums[], ${unmatched} non matchés (tous indexés dans musicbee_tracks)`);
  invalidateCache();
  updateNavBadges();
  if (document.getElementById('sec-missing-tracks')?.classList.contains('active')) {
    renderMissingTracks();
  }
  return matched;
}

// Flush toutes les pistes MusicBee vers musicbee_tracks (remplace le contenu entier)
// Toutes les pistes sont dans byKey (albums + stock + isolated + ok + forsale)
async function saveMusicBeeTracks(byKey) {
  if (!window._sb) return;
  const rows = [];
  const seenKeys = new Set();

  Object.values(byKey).forEach(g => {
    g.tracks.forEach(t => {
      if (!t.title) return;
      // Utiliser l'artiste individuel pour la dédup si dispo (compilations)
      const effectiveArtist = (t.trackArtist && t.trackArtist !== g.artist) ? t.trackArtist : g.artist;
      const an = normalizeKey(effectiveArtist, '').replace('|||', '');
      const tn = normalizeKey('', t.title).replace('|||', '');
      const pk = an + '|||' + tn;
      if (seenKeys.has(pk)) return;
      seenKeys.add(pk);
      rows.push({
        artist:          effectiveArtist,
        album:           g.album  || null,
        title:           t.title,
        artist_norm:     an,
        title_norm:      tn,
        track_artist:    t.trackArtist || null,
        folder:          t.folder || g.folder || 'album',
        position:        t.position    || null,
        duration:        t.duration    || null,
        bitrate:         t.bitrate     || null,
        play_count:      t.play_count  || null,
        disc_number:     t.disc_number || null,
        rating:          t.rating      || null,
        mb_recording_id: t.mb_recording_id || null,
        updated_at:      new Date().toISOString(),
      });
    });
  });

  if (!rows.length) return;
  try {
    await window._sb.from('musicbee_tracks').delete().neq('artist_norm', '___never___');
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await window._sb.from('musicbee_tracks').insert(rows.slice(i, i + 400));
      if (error) console.warn('saveMusicBeeTracks chunk error:', error.message);
    }
    const byFolder = rows.reduce((acc, r) => { acc[r.folder] = (acc[r.folder]||0)+1; return acc; }, {});
    console.log(`musicbee_tracks : ${rows.length} pistes sauvegardées`, byFolder);
  } catch(e) { console.warn('saveMusicBeeTracks:', e); }
}

// Charger musicbee_tracks depuis Supabase au démarrage → peuple window._mbTrackKeys
async function loadMusicBeeTracks() {
  if (!window._sb) return;
  // Ne pas recharger si déjà peuplé par un import XML récent
  if (window._mbTrackKeys && window._mbTrackKeys.size > 0) return;
  try {
    let all = [], page = 0;
    while (true) {
      const { data, error } = await window._sb
        .from('musicbee_tracks')
        .select('artist,album,title,artist_norm,title_norm,bitrate,play_count,rating,mb_recording_id,folder,track_artist')
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) {
        const ignorable = ['PGRST205', '42501', 'PGRST301'];
        if (ignorable.includes(error.code) || error.message?.includes('does not exist')) {
          console.info('musicbee_tracks : table absente — créez-la via le SQL fourni');
        } else {
          console.warn('loadMusicBeeTracks:', error);
        }
        break;
      }
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      page++;
    }
    if (all.length) {
      window._mbTrackKeys = new Set();
      window._albumTracksByKey = window._albumTracksByKey || {};
      all.forEach(t => {
        const clean = cleanDiscogsArtist(t.artist);
        const noThe = (t.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,'');
        // Ajouter toutes les variantes artiste × variantes titre
        for (const art of [t.artist, clean, noThe]) {
          for (const k of normalizeKeyLoose(art, t.title)) {
            window._mbTrackKeys.add(k);
          }
        }
        // Indexer aussi track_artist si différent (compilations)
        if (t.track_artist && t.track_artist !== t.artist) {
          const tClean = cleanDiscogsArtist(t.track_artist);
          const tNoThe = t.track_artist.replace(/^The\s+/i,'').replace(/^A\s+/i,'');
          for (const art of [t.track_artist, tClean, tNoThe]) {
            for (const k of normalizeKeyLoose(art, t.title)) {
              window._mbTrackKeys.add(k);
            }
          }
        }
        // _albumTracksByKey pour renderTrackAssocList (pistes d'albums uniquement)
        if (t.folder !== 'isolated') {
          const albumKey = normalizeKey(t.artist, t.album || '');
          if (!window._albumTracksByKey[albumKey]) {
            window._albumTracksByKey[albumKey] = { artist: t.artist, album: t.album || '', tracks: [] };
          }
          window._albumTracksByKey[albumKey].tracks.push({
            title: t.title, source: 'musicbee',
            bitrate: t.bitrate, play_count: t.play_count,
            rating: t.rating, mb_recording_id: t.mb_recording_id,
          });
        }
      });
      // Construire _mbRecordingIds — Set des recording_mbid possédés
      // Utilisé par computeMissingTracks pour le matching MBID prioritaire (LB)
      window._mbRecordingIds = new Set();
      all.forEach(t => { if (t.mb_recording_id) window._mbRecordingIds.add(t.mb_recording_id); });
      console.log(`_mbRecordingIds : ${window._mbRecordingIds.size} MBIDs depuis musicbee_tracks`);

      const byFolder = all.reduce((acc, t) => { acc[t.folder||'album'] = (acc[t.folder||'album']||0)+1; return acc; }, {});
      // Peupler albumTracksCache depuis les données musicbee_tracks
      // (équivalent de ce que fait importMusicBeeTracklists après un import XML)
      const mbAlbumIndex = new Map();
      albums.forEach(a => {
        const key = normalizeKey(a.artist, a.album);
        if (!mbAlbumIndex.has(key)) mbAlbumIndex.set(key, a);
        const cleanKey = normalizeKey(cleanDiscogsArtist(a.artist), a.album);
        if (!mbAlbumIndex.has(cleanKey)) mbAlbumIndex.set(cleanKey, a);
        const noTheKey = normalizeKey((a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,''), a.album);
        if (!mbAlbumIndex.has(noTheKey)) mbAlbumIndex.set(noTheKey, a);
        if (a.mb_release_id) mbAlbumIndex.set('mbid:' + a.mb_release_id, a);
        // Various Artists
        const normArt = normalizeKey(a.artist,'').replace('|||','');
        if (normArt === 'various' || normArt === 'various artists') {
          ['various', 'various artists'].forEach(v => {
            const k2 = v + '|||' + normalizeKey('', a.album).replace('|||','');
            if (!mbAlbumIndex.has(k2)) mbAlbumIndex.set(k2, a);
          });
        }
      });

      // Grouper les pistes par (artist, album) pour les injecter dans albumTracksCache
      const mbByAlbumKey = new Map();
      all.forEach(t => {
        if (!t.album || t.folder === 'isolated') return;
        const key = normalizeKey(t.artist, t.album);
        if (!mbByAlbumKey.has(key)) mbByAlbumKey.set(key, []);
        mbByAlbumKey.get(key).push({
          position: null, title: t.title, duration: null, source: 'musicbee',
          bitrate: t.bitrate, sample_rate: null, file_size: null,
          play_count: t.play_count, last_played: null, date_added: null,
          composer: null, isrc: null, mb_recording_id: t.mb_recording_id,
          disc_number: t.disc_number, rating: t.rating,
        });
      });

      mbByAlbumKey.forEach((tracks_, key) => {
        let albumObj = mbAlbumIndex.get(key);
        if (!albumObj) {
          // Essayer variantes artiste
          const [artistPart, albumPart] = key.split('|||');
          for (const [k2, a] of mbAlbumIndex) {
            if (k2.endsWith('|||' + albumPart) && (
              k2.startsWith(artistPart) || artistPart.startsWith(k2.split('|||')[0])
            )) { albumObj = a; break; }
          }
        }
        if (albumObj) {
          const existing = albumTracksCache[albumObj.id] || [];
          const hasMb = existing.some(t => t.source === 'musicbee');
          if (!hasMb) {
            albumTracksCache[albumObj.id] = existing.concat(tracks_);
          }
        }
      });

      console.log(`musicbee_tracks chargés : ${all.length} pistes → ${window._mbTrackKeys.size} clés`, byFolder);
      invalidateCache();
      updateNavBadges();
      if (document.getElementById('sec-missing-tracks')?.classList.contains('active')) {
        renderMissingTracks();
      }
    }
  } catch(e) { console.warn('loadMusicBeeTracks:', e); }
}

async function loadAlbumTracks() {
  if (!window._sb) return;
  if (window._skipLoadAlbumTracks) return;
  try {
    let all = [], page = 0;
    while (true) {
      const { data, error } = await window._sb.from('album_tracks')
        .select('album_id,position,title,duration,source,bitrate,sample_rate,file_size,play_count,last_played,date_added,composer,isrc,mb_recording_id,disc_number,rating')
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) {
        const ignorable = ['PGRST205', '42501', 'PGRST301'];
        if (ignorable.includes(error.code) || error.message?.includes('does not exist') || error.status === 400) {
          console.info('album_tracks : table non accessible');
        } else {
          console.warn('loadAlbumTracks:', error);
        }
        break;
      }
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      page++;
    }
    if (all.length) {
      albumTracksCache = {};
      all.forEach(t => {
        // album_id est maintenant un text stable (normalizeKey ou mb:...)
        const aid = String(t.album_id);
        if (!albumTracksCache[aid]) albumTracksCache[aid] = [];
        albumTracksCache[aid].push({
          position: t.position, title: t.title, duration: t.duration, source: t.source,
          bitrate: t.bitrate, sample_rate: t.sample_rate, file_size: t.file_size,
          play_count: t.play_count, last_played: t.last_played, date_added: t.date_added,
          composer: t.composer, isrc: t.isrc, mb_recording_id: t.mb_recording_id,
          disc_number: t.disc_number, rating: t.rating || 0,
        });
      });
      console.log(`Album tracks chargés : ${all.length} pistes pour ${Object.keys(albumTracksCache).length} albums`);

      // Reconstruire _albumTracksByKey depuis albumTracksCache + albums[]
      window._albumTracksByKey = window._albumTracksByKey || {};
      albums.forEach(a => {
        const atracks = (albumTracksCache[a.id] || []).filter(t => t.source === 'musicbee');
        if (!atracks.length) return;
        const albumNorm = normalizeKey('', a.album).replace('|||', '');
        for (const av of artistVariants(a.artist)) {
          const k = av + '|||' + albumNorm;
          if (!window._albumTracksByKey[k]) {
            window._albumTracksByKey[k] = { artist: a.artist, album: a.album, tracks: atracks };
          }
        }
      });

      if (_dataReady) {
        invalidateCache();
        updateNavBadges();
        if (document.getElementById('sec-missing-tracks')?.classList.contains('active')) {
          renderMissingTracks();
        }
      }
    }
  } catch(e) { console.warn('loadAlbumTracks:', e); }
}

// Comparer tracklists Discogs vs MusicBee pour un album
function compareTracklists(albumId) {
  const tracks_ = albumTracksCache[albumId] || [];
  const discogs      = tracks_.filter(t => t.source === 'discogs');
  const musicbee     = tracks_.filter(t => t.source === 'musicbee');
  const musicbrainz  = tracks_.filter(t => t.source === 'musicbrainz');
  if (!discogs.length && !musicbee.length && !musicbrainz.length) return null;

  // Référence principale : Discogs si dispo, sinon MusicBrainz
  const reference = discogs.length ? discogs : musicbrainz;
  const refTitles = new Set(reference.map(t => normalizeKey('', t.title)));
  const mbTitles  = new Set(musicbee.map(t => normalizeKey('', t.title)));

  return {
    discogs,
    musicbee,
    musicbrainz,
    reference,
    onlyInDiscogs:      reference.filter(t => !mbTitles.has(normalizeKey('', t.title))),
    onlyInMusicBee:     musicbee.filter(t => !refTitles.has(normalizeKey('', t.title))),
    matched:            reference.filter(t => mbTitles.has(normalizeKey('', t.title))).length,
    // Statistiques MusicBee
    avgBitrate: musicbee.length
      ? Math.round(musicbee.filter(t => t.bitrate).reduce((s,t) => s + t.bitrate, 0) / (musicbee.filter(t=>t.bitrate).length||1))
      : 0,
    totalPlays: musicbee.reduce((s,t) => s + (t.play_count||0), 0),
  };
}

function showTracklistDiff(albumId) {
  const album = albums.find(a => a.id === albumId);
  const cmp = compareTracklists(albumId);
  if (!cmp || !album) return;

  document.getElementById('tracklist-diff-title').textContent = `${album.artist} — ${album.album}`;

  const renderList = (tracks_, color, label) => {
    if (!tracks_.length) return '';
    return `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:${color};margin-bottom:8px">${label} (${tracks_.length})</div>
      <table style="width:100%;border-collapse:collapse">
        ${tracks_.map(t => `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:4px 8px;color:var(--text3);font-size:11px;width:40px">${esc(t.position)}</td>
          <td style="padding:4px 8px">${esc(t.title)}</td>
          <td style="padding:4px 8px;color:var(--text3);font-size:11px;text-align:right">${esc(t.duration)}</td>
        </tr>`).join('')}
      </table>
    </div>`;
  };

  const renderFull = (tracks_, label) => {
    if (!tracks_.length) return `<div style="color:var(--text3);font-size:12px;margin-bottom:16px">${label} : aucune piste</div>`;
    const isMusicBee = label.includes('MusicBee');
    return `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">${label} — ${tracks_.length} pistes</div>
      <table style="width:100%;border-collapse:collapse">
        ${tracks_.map(t => {
          const inOther = label.includes('Discogs')
            ? new Set(cmp.musicbee.map(x => normalizeKey('',x.title))).has(normalizeKey('',t.title))
            : new Set(cmp.discogs.map(x => normalizeKey('',x.title))).has(normalizeKey('',t.title));
          const bg = inOther ? '' : 'background:rgba(255,100,100,0.08)';
          // Infos enrichies MusicBee
          let extra = '';
          if (isMusicBee) {
            const br = t.bitrate ? `${t.bitrate}kbps` : '';
            const sr = t.sample_rate ? `${(t.sample_rate/1000).toFixed(1)}kHz` : '';
            const pc = t.play_count ? `▶${t.play_count}` : '';
            const comp = t.composer ? `✍ ${esc(t.composer)}` : '';
            const info = [br, sr, pc, comp].filter(Boolean).join(' · ');
            if (info) extra = `<div style="font-size:10px;color:var(--text3);margin-top:1px">${info}</div>`;
          } else if (t.isrc) {
            extra = `<div style="font-size:10px;color:var(--text3);margin-top:1px">${t.isrc}</div>`;
          }
          return `<tr style="border-bottom:1px solid var(--border);${bg}">
            <td style="padding:4px 8px;color:var(--text3);font-size:11px;width:40px">${esc(t.position)}</td>
            <td style="padding:4px 8px"><div>${esc(t.title)} ${inOther ? '' : '<span style="font-size:10px;color:var(--red)">✗</span>'}</div>${extra}</td>
            <td style="padding:4px 8px;color:var(--text3);font-size:11px;text-align:right;white-space:nowrap">${esc(t.duration)}</td>
          </tr>`;
        }).join('')}
      </table>
    </div>`;
  };

  const hasEcarts = cmp.onlyInDiscogs.length || cmp.onlyInMusicBee.length;
  let html = '';

  // Statistiques MusicBee
  if (cmp.avgBitrate || cmp.totalPlays) {
    const brLabel = cmp.avgBitrate >= 900 ? 'FLAC/lossless' : cmp.avgBitrate >= 256 ? 'haute qualité' : cmp.avgBitrate >= 128 ? 'bonne qualité' : 'qualité basse';
    html += `<div style="display:flex;gap:12px;margin-bottom:12px;font-size:12px;color:var(--text2)">
      ${cmp.avgBitrate ? `<span>📊 Bitrate moyen : <strong>${cmp.avgBitrate} kbps</strong> (${brLabel})</span>` : ''}
      ${cmp.totalPlays ? `<span>▶ Écoutes MusicBee : <strong>${cmp.totalPlays}</strong></span>` : ''}
    </div>`;
  }

  if (hasEcarts) {
    html += `<div style="padding:10px;background:rgba(255,180,0,0.08);border:1px solid rgba(255,180,0,0.2);border-radius:var(--radius);margin-bottom:16px;font-size:12px">
      ⚠️ <strong>${cmp.onlyInDiscogs.length}</strong> piste${cmp.onlyInDiscogs.length>1?'s':''} référence absentes de MusicBee —
      <strong>${cmp.onlyInMusicBee.length}</strong> piste${cmp.onlyInMusicBee.length>1?'s':''} MusicBee en bonus —
      <strong>${cmp.matched}</strong> commune${cmp.matched>1?'s':''}
    </div>`;
    html += renderList(cmp.onlyInDiscogs,  'var(--red)',   '🔴 Référence uniquement (fichiers manquants ?)');
    html += renderList(cmp.onlyInMusicBee, 'var(--amber)', '🟡 MusicBee uniquement (bonus tracks ?)');
    html += '<div style="border-top:1px solid var(--border);margin:16px 0"></div>';
  } else {
    html += `<div style="padding:10px;background:rgba(100,220,100,0.08);border:1px solid rgba(100,220,100,0.2);border-radius:var(--radius);margin-bottom:16px;font-size:12px">
      ✅ Tracklists cohérentes — ${cmp.matched} pistes communes
    </div>`;
  }

  // Affichage colonnes : Discogs / MusicBrainz / MusicBee
  const refLabel = cmp.discogs.length ? '💿 Discogs' : '🔵 MusicBrainz';
  const cols = cmp.discogs.length && cmp.musicbrainz.length
    ? `grid-template-columns:1fr 1fr 1fr`
    : `grid-template-columns:1fr 1fr`;
  html += `<div style="display:grid;${cols};gap:16px">
    ${renderFull(cmp.reference, refLabel)}
    ${cmp.discogs.length && cmp.musicbrainz.length ? renderFull(cmp.musicbrainz, '🔵 MusicBrainz') : ''}
    ${renderFull(cmp.musicbee, '🎵 MusicBee')}
  </div>`;

  document.getElementById('tracklist-diff-body').innerHTML = html;
  document.getElementById('modal-tracklist-diff').classList.add('open');
}

// ===================== WISHLIST =====================
let wishlist = []; // [{ id, artist, album, year, source, prio, plays, rymRating, notes, addedAt }]

function wishlistOwnedSet() {
  // Albums déjà possédés — au sens Discogs, seul contrôle faisant foi ici (confirmé par Antoine
  // le 2026-07-11) : la wishlist ne doit contenir QUE des albums absents de Discogs. Un album
  // présent uniquement en Stock (fichiers MusicBee déjà présents mais pas encore reportés dans
  // Discogs/discographie) n'est PAS "possédé" au sens de la wishlist, même s'il a des fichiers
  // flac/mp3/cd/digital — sans cette distinction, pruneWishlistOwned() videait silencieusement
  // toute la wishlist correspondant à des albums déjà ripés en Stock mais pas encore
  // officiellement collectés (bug corrigé v2026.07.10-22, cf. discogsId comme seul critère).
  // Correspondance EXACTE uniquement (clé normalisée artiste+album) : un faux-positif ici
  // supprime silencieusement une entrée qu'on vient d'ajouter, donc mieux vaut louper
  // un match approximatif que perdre une entrée légitime.
  const s = new Set();
  albums.forEach(a => {
    if (!a.discogsId) return;
    s.add(normalizeKey(a.artist, a.album));
  });
  return s;
}

// Retire de la wishlist les entrées devenues présentes dans Discogs (ex: après un réimport
// Discogs qui vient d'ajouter un album qui était en wishlist). Appelé automatiquement — pas
// besoin de cliquer manuellement sur ✓ pour chaque album retrouvé via un import.
// IMPORTANT : ne touche que les entrées ajoutées automatiquement (source last.fm/RYM,
// "cet album me manque"). Les ajouts manuels/stock (source 'manual'/'stock', ex: "je veux
// aussi le CD d'un album que j'ai déjà en numérique") ne sont JAMAIS auto-retirés, car
// l'utilisateur les a ajoutés en sachant déjà qu'il possède l'album dans un autre format.
// Retire automatiquement de la wishlist tout album devenu présent dans Discogs, quelle que
// soit sa source d'ajout (lastfm/rym/stock/manual) — auparavant limité à lastfm/rym.
// Généralisé en v2026.07.10-03 suite au retrait du bouton "✓ Acquis" (qui ouvrait la
// modale d'ajout manuel) : sans lui, c'est ce nettoyage automatique après réimport Discogs
// qui fait disparaître une entrée une fois réellement acquise. Le critère est Discogs
// spécifiquement (a.discogsId), PAS la présence de fichiers flac/mp3/cd/digital — un album
// seulement en Stock (ripé mais pas encore reporté dans Discogs) reste en wishlist tant qu'il
// n'est pas dans Discogs (confirmé par Antoine, v2026.07.10-22, cf. wishlistOwnedSet()).
function pruneWishlistOwned() {
  if (!wishlist.length) return 0;
  const owned = wishlistOwnedSet();
  const before = wishlist.length;
  const toRemove = wishlist.filter(w => owned.has(normalizeKey(w.artist, w.album)));
  if (toRemove.length) console.warn('pruneWishlistOwned: entrées retirées (déjà possédées)', toRemove.map(w => `${w.artist} — ${w.album}`));
  wishlist = wishlist.filter(w => !owned.has(normalizeKey(w.artist, w.album)));
  const removed = before - wishlist.length;
  if (removed) saveToStorage();
  return removed;
}

// Migration/nettoyage : certaines entrées "album" de la wishlist sont en fait des singles
// last.fm dont le tag Album est identique au titre du morceau (cas fréquent pour les singles
// isolés) — elles ont été ajoutées par erreur à la wishlist albums au lieu de la wishlist
// morceaux. On les détecte via leur note "Morceau : {titre}" et on les déplace.
function migrateTrackLikeWishlistEntries() {
  if (!wishlist.length) return 0;
  let moved = 0;
  wishlist = wishlist.filter(w => {
    const m = /^Morceau\s*:\s*(.+)$/i.exec((w.notes || '').trim());
    if (!m) return true;
    const trackTitle = m[1].trim();
    const sameAsAlbum = normalizeKey('', w.album).replace('|||', '') === normalizeKey('', trackTitle).replace('|||', '');
    if (!sameAsAlbum) return true;
    const key = normalizeKey(w.artist, trackTitle);
    if (!trackWishlist.find(t => normalizeKey(t.artist, t.title) === key)) {
      trackWishlist.push({ id: uid(), artist: w.artist, title: trackTitle, album: '', prio: w.prio || 'mid', addedAt: w.addedAt || Date.now() });
      moved++;
    }
    return false;
  });
  if (moved) saveToStorage();
  return moved;
}

// Purge les entrées wishlist déjà corrompues par le bug "[object Object]" (artiste ou
// album non-string, hérité d'un ancien bug de récupération du tag album last.fm — l'API
// retourne parfois album sous forme d'objet { "#text": "...", mbid: "..." } au lieu d'une chaîne).
function cleanupCorruptedWishlistEntries() {
  if (!wishlist.length) return 0;
  const before = wishlist.length;
  wishlist = wishlist.filter(w =>
    typeof w.artist === 'string' && typeof w.album === 'string'
    && w.artist.trim() && w.album.trim()
    && w.artist !== '[object Object]' && w.album !== '[object Object]'
  );
  const removed = before - wishlist.length;
  if (removed) saveToStorage();
  return removed;
}

function addToWishlist(artist, album, year, source, plays, rymRating, notes) {
  // Garde-fou : l'API last.fm retourne parfois le champ album sous forme d'objet
  // ({ "#text": "...", mbid: "..." }) plutôt qu'une chaîne — sans ce contrôle, ça finissait
  // stocké tel quel puis affiché comme "[object Object]" dans la wishlist.
  if (typeof artist !== 'string' || typeof album !== 'string'
      || !artist.trim() || !album.trim() || album === '[object Object]' || artist === '[object Object]') {
    console.warn('addToWishlist: artist/album invalide, ignoré', artist, album);
    return;
  }
  const key = normalizeKey(artist, album);
  if (wishlist.find(w => normalizeKey(w.artist, w.album) === key)) {
    toast('Déjà dans la wishlist', 'warn'); return;
  }
  // Priorité auto selon écoutes / note RYM
  let prio = 'low';
  if (plays >= 50 || rymRating >= 4) prio = 'high';
  else if (plays >= 10 || rymRating >= 3.5) prio = 'mid';
  wishlist.push({ id: uid(), artist, album, year: year || '', source: source || 'manual',
    prio, plays: plays || 0, rymRating: rymRating || 0, notes: notes || '', addedAt: Date.now() });
  updateNavBadges();
  saveToStorage();
  toast(`Ajouté à la wishlist : ${artist} — ${album}`);
}


function openWishModal(id) {
  const w = id ? wishlist.find(x => x.id === id) : null;
  document.getElementById('wish-edit-id').value = id || '';
  document.getElementById('wish-f-artist').value = w?.artist || '';
  document.getElementById('wish-f-album').value  = w?.album  || '';
  document.getElementById('wish-f-year').value   = w?.year   || '';
  document.getElementById('wish-f-prio').value   = w?.prio   || 'mid';
  document.getElementById('wish-f-notes').value  = w?.notes  || '';
  document.getElementById('modal-wish').classList.add('open');
}

function saveWish() {
  const id    = document.getElementById('wish-edit-id').value;
  const artist = document.getElementById('wish-f-artist').value.trim();
  const album  = document.getElementById('wish-f-album').value.trim();
  if (!artist || !album) { toast('Artiste et album requis', 'error'); return; }
  const year  = document.getElementById('wish-f-year').value.trim();
  const prio  = document.getElementById('wish-f-prio').value;
  const notes = document.getElementById('wish-f-notes').value.trim();
  if (id) {
    const w = wishlist.find(x => x.id == id);
    if (w) Object.assign(w, { artist, album, year, prio, notes });
  } else {
    const key = normalizeKey(artist, album);
    if (wishlist.find(w => normalizeKey(w.artist, w.album) === key)) {
      toast('Déjà dans la wishlist', 'warn'); return;
    }
    wishlist.push({ id: uid(), artist, album, year, source: 'manual', prio, plays: 0, rymRating: (lookupRym(artist, album) || lookupRym(cleanDiscogsArtist(artist), album))?.rating || 0, notes, addedAt: Date.now() });
  }
  document.getElementById('modal-wish').classList.remove('open');
  renderWishlist(); updateNavBadges(); saveToStorage();
}

function deleteWish(id) {
  if (!confirm('Retirer de la wishlist ?')) return;
  wishlist = wishlist.filter(w => w.id !== id);
  selectedWishIds.delete(id);
  renderWishlist(); updateNavBadges(); saveToStorage();
}

// markWishAcquired supprimée (v2026.07.10-03) : ouvrait la modale d'ajout manuel
// d'album, retirée pour cohérence avec le principe "ajouts/suppressions uniquement
// via imports MusicBee/Discogs". Une fois l'album réellement acquis et réimporté,
// pruneWishlistOwned() (généralisée à toutes les sources, cf. plus bas) retire
// automatiquement l'entrée de la wishlist.

// ===================== OK ALBUMS =====================
function renderOkAlbums() {
  const q       = (document.getElementById('global-search').value || '').toLowerCase();
  const af      = (document.getElementById('filter-ok-artist')?.value || '').toLowerCase().trim();
  const albf    = (document.getElementById('filter-ok-album')?.value  || '').toLowerCase().trim();
  const yf      = (document.getElementById('filter-ok-year')?.value   || '').trim();
  const genreF  = document.getElementById('filter-ok-genre')?.value   || '';
  const noteF   = document.getElementById('filter-ok-note')?.value    || '';
  const dcNoteF = document.getElementById('filter-ok-dc-note')?.value || '';
  const rymNoteF= document.getElementById('filter-ok-rym-note')?.value|| '';
  const supF    = document.getElementById('filter-ok-support')?.value || '';
  const minPlays= parseInt(document.getElementById('filter-ok-min-plays')?.value || '0') || 0;
  const sortF   = document.getElementById('sort-ok')?.value || 'artist';

  // Mettre à jour le select genre
  const genreSel = document.getElementById('filter-ok-genre');
  if (genreSel && genreSel.options.length <= 1) {
    const genres = [...new Set(albums.filter(a=>a.okFolder).map(a=>a.genre).filter(Boolean))].sort();
    genres.forEach(g => { const o=document.createElement('option');o.value=g;o.textContent=g;genreSel.appendChild(o); });
  }

  let list = albums.filter(a => a.okFolder).filter(a => {
    if (q   && !(a.artist+' '+a.album).toLowerCase().includes(q)) return false;
    if (af  && !a.artist.toLowerCase().includes(af))  return false;
    if (albf&& !a.album.toLowerCase().includes(albf)) return false;
    if (yf  && !(a.year||'').startsWith(yf))          return false;
    if (genreF && a.genre !== genreF)                 return false;
    // Note MB
    if (noteF) {
      if (noteF==='5' && a.note!==5) return false;
      if (noteF==='4' && (a.note||0)<4) return false;
      if (noteF==='3' && (a.note||0)<3) return false;
      if (noteF==='0' && a.note)        return false;
    }
    // Note DC
    if (dcNoteF) {
      const dc = a.discogsRating || 0;
      if (dcNoteF==='5' && dc!==5) return false;
      if (dcNoteF==='4' && dc<4)   return false;
      if (dcNoteF==='3' && dc<3)   return false;
      if (dcNoteF==='0' && dc)     return false;
    }
    // Note RYM
    if (rymNoteF) {
      const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
      if (rymNoteF==='0') { if (rymEntry?.rating) return false; }
      else if (!(rymEntry && rymEntry.rating >= parseFloat(rymNoteF))) return false;
    }
    // Support
    if (supF==='cd'      && !a.cd)                           return false;
    if (supF==='flac'    && !a.flac)                          return false;
    if (supF==='mp3'     && !a.mp3)                           return false;
    if (supF==='digital' && !(a.flac||a.mp3||a.digital))     return false;
    // Écoutes min
    if (minPlays > 0 && (a.plays||0) < minPlays)             return false;
    return true;
  });

  // Tri
  if (sortF==='album')  list.sort((a,b)=>a.album.localeCompare(b.album,'fr'));
  else if (sortF==='year')  list.sort((a,b)=>(b.year||0)-(a.year||0));
  else if (sortF==='note')  list.sort((a,b)=>(b.note||0)-(a.note||0));
  else if (sortF==='plays') list.sort((a,b)=>(b.plays||0)-(a.plays||0));
  else if (sortF==='rym')   list.sort((a,b)=>{
    const ra=(lookupRym(a.artist,a.album,a.id)||lookupRym(cleanDiscogsArtist(a.artist),a.album,a.id))?.rating||0;
    const rb=(lookupRym(b.artist,b.album,b.id)||lookupRym(cleanDiscogsArtist(b.artist),b.album,b.id))?.rating||0;
    return rb-ra;
  });
  else list.sort((a,b)=>a.artist.localeCompare(b.artist,'fr'));

  const ctr = document.getElementById('ok-counter');
  if (ctr) ctr.textContent = list.length + ' / ' + albums.filter(a=>a.okFolder).length + ' albums';
  const badge = document.getElementById('nav-ok-count');
  if (badge) badge.textContent = albums.filter(a=>a.okFolder).length;
  const tbody = document.getElementById('ok-tbody');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-icon">✅</div>Aucun album dans Ok/</div></td></tr>'; return; }

  const fmtBadge = a => [
    a.cd  ?'<span class="badge badge-cd">CD</span>':'',
    a.flac?'<span class="badge badge-flac">FLAC</span>':'',
    a.mp3 ?'<span class="badge badge-mp3">MP3</span>':'',
  ].filter(Boolean).join('');

const noteCell = a => a.note ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${a.note.toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`;

  const rymCell = a => {
    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    const hasManual = rymAssociations.some(x => x.albumKey === a.id);
    return `<span onclick="event.stopPropagation();openRYMAssocFromCollection('${sid(a.id)}')" title="Associer/modifier la note RYM" style="cursor:pointer;display:inline-flex;align-items:center;gap:3px">
      ${rymEntry?.rating
        ? `<span style="font-family:var(--mono);font-size:12px;color:var(--amber)">${rymEntry.rating.toFixed(2)}<span style="font-size:10px;opacity:0.7">★</span></span>${hasManual ? '<span style="font-size:9px;color:var(--accent)">🔗</span>' : ''}`
        : `<span style="color:var(--text3);font-size:12px;opacity:0.35">⭐</span>`}
    </span>`;
  };

  tbody.innerHTML = list.map(a => `<tr>
    <td><div class="artist-cell"><div class="artist-avatar">${albumAvatar(a)}</div><div class="artist-info"><div class="name">${esc(a.album)}</div><div class="sub">${esc(a.artist)}</div></div></div></td>
    <td class="mono">${a.year||'–'}</td>
    <td style="font-size:12px;color:var(--text2)">${esc(a.genre||'–')}</td>
    <td><div class="badges-cell">${fmtBadge(a)||'<span style="color:var(--text3);font-size:11px">–</span>'}</div></td>
    <td>${noteCell(a)}</td>
    <td>${a.discogsRating ? `<span style="font-family:var(--mono);font-size:12px;color:var(--blue)">${a.discogsRating}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`}</td>
    <td>${rymCell(a)}</td>
    <td>
      <div class="plays-bar-wrap">
        <div class="plays-bar"><div class="plays-fill" style="width:${Math.round((a.plays||0)/Math.max(1,...albums.map(x=>x.plays||0))*100)}%"></div></div>
        <span class="plays-num">${a.plays||0}</span>
      </div>
    </td>
    <td style="display:flex;gap:4px">
      <button class="btn btn-sm" onclick="addToWishlistFromAlbumId('${sid(a.id)}')" title="Wishlist">🎯</button>
      <button class="btn btn-sm btn-danger" onclick="markOkDone('${sid(a.id)}')" title="Retirer de Ok">✕</button>
    </td>
  </tr>`).join('');
}

function markOkDone(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  a.okFolder = false;
  if (a.folders) a.folders = a.folders.filter(f => f !== 'ok');
  invalidateCache(); saveToStorage(); renderOkAlbums(); renderAlbums(); updateNavBadges();
}

// ===================== FOR SALE =====================
function renderForSale() {
  const q  = (document.getElementById('global-search').value || '').toLowerCase();
  const af = (document.getElementById('filter-forsale-artist')?.value || '').toLowerCase().trim();
  const yf = (document.getElementById('filter-forsale-year')?.value || '').trim();
  const list = albums.filter(a => a.forSale)
    .filter(a => (!q || (a.artist+' '+a.album).toLowerCase().includes(q))
              && (!af || a.artist.toLowerCase().includes(af))
              && (!yf || (a.year||'').startsWith(yf)))
    .sort((a,b) => a.artist.localeCompare(b.artist,'fr'));
  const ctr = document.getElementById('forsale-counter');
  if (ctr) ctr.textContent = list.length + ' albums';
  const badge = document.getElementById('nav-forsale-count');
  if (badge) badge.textContent = list.length;
  const tbody = document.getElementById('forsale-tbody');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">💸</div>Aucun album à vendre</div></td></tr>'; return; }
  const fmtBadge = a => [a.cd?'<span class="badge badge-cd">CD</span>':'', a.flac?'<span class="badge badge-flac">FLAC</span>':'', a.mp3?'<span class="badge badge-mp3">MP3</span>':''].filter(Boolean).join('');
   const noteCell = a => a.note ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${a.note.toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`;
  tbody.innerHTML = list.map(a => `<tr>
    <td><div class="artist-cell"><div class="artist-avatar">${albumAvatar(a)}</div><div class="artist-info"><div class="name">${esc(a.album)}</div><div class="sub">${esc(a.artist)}</div></div></div></td>
    <td class="mono">${a.year||'–'}</td>
    <td><div class="badges-cell">${fmtBadge(a)}</div></td>
    <td>${noteCell(a)}</td>
    <td><button class="btn btn-sm" onclick="unmarkForSale('${sid(a.id)}')" title="Retirer">✓</button></td>
  </tr>`).join('');
}

function markForSale(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  a.forSale = true;
  if (!a.folders) a.folders = [];
  if (!a.folders.includes('forsale')) a.folders.push('forsale');
  invalidateCache(); saveToStorage(); renderDiscographie(); renderForSale(); renderAlbums(); updateNavBadges();
  toast(`${a.artist} — ${a.album} marqué à vendre`);
}
function unmarkForSale(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (!a) return;
  a.forSale = false;
  if (a.folders) a.folders = a.folders.filter(f => f !== 'forsale');
  invalidateCache(); saveToStorage(); renderForSale(); renderAlbums(); updateNavBadges();
}

// ===================== ALL TRACKS =====================
function buildAllTracksList() {
  if (_cache.allTracksList) return _cache.allTracksList;
  const result = [];

  // Index albums par id pour lookups rapides
  const albumById = new Map(albums.map(a => [a.id, a]));

  // 1. Pistes des albums (source musicbee en priorité, sinon discogs)
  let mbCount = 0;
  albums.forEach(a => {
    const atracks = albumTracksCache[a.id] || [];
    const mbTracks = atracks.filter(t => t.source === 'musicbee');
    let useTracks = mbTracks.length ? mbTracks : atracks.filter(t => t.source === 'discogs');
    // Un CD Discogs sans pistes MusicBee propres peut être associé (🔗 sur la page
    // Discographie) à une version numérique enregistrée sous un AUTRE id d'album — dans ce
    // cas le bitrate existe bien quelque part, juste pas rattaché à cet id-ci. On l'injecte
    // dans le tracklist Discogs en matchant par titre normalisé, au lieu d'afficher "–".
    if (!mbTracks.length && useTracks.length) {
      const linkedKeys = getLinkedNumKeys(String(a.id));
      for (const lk of linkedKeys) {
        const linkedAlbum = albumByKey(lk);
        if (!linkedAlbum) continue;
        const linkedMbTracks = (albumTracksCache[linkedAlbum.id] || []).filter(t => t.source === 'musicbee');
        if (!linkedMbTracks.length) continue;
        const byTitle = new Map(linkedMbTracks.map(t => [normalizeKey('', t.title).replace('|||', ''), t]));
        useTracks = useTracks.map(t => {
          const m = byTitle.get(normalizeKey('', t.title).replace('|||', ''));
          return m ? { ...t, bitrate: m.bitrate || t.bitrate } : t;
        });
        break;
      }
    }
    useTracks.forEach(t => {
      result.push({ title: t.title, artist: a.artist, album: a.album, albumId: a.id,
        source: t.source, bitrate: t.bitrate, duration: t.duration, play_count: t.play_count,
        inStock: false });
      if (t.source === 'musicbee') mbCount++;
    });
  });

  // 2. Pistes des albums en stock via _albumTracksByKey (keyed by normalizeKey stable)
  // On NE PAS utiliser albumTracksCache[stockItem.id] car les IDs stock sont régénérés
  // via uid() à chaque import XML — la liaison par ID est donc systématiquement cassée.
  // _albumTracksByKey est peuplé soit depuis le XML import (importMusicBeeTracklists),
  // soit depuis loadMusicBeeTracks (table musicbee_tracks Supabase) — clé toujours valide.
  const stockKeys = getStockKeysSet();
  const albumNormKeys = new Set(albums.map(a => normalizeKey(a.artist, a.album)));
  if (window._albumTracksByKey) {
    Object.values(window._albumTracksByKey).forEach(g => {
      const gKey = normalizeKey(g.artist, g.album || '');
      // Inclure seulement si c'est un album stock ET pas déjà dans section 1 (albums[])
      if (!stockKeys.has(gKey)) return;
      if (albumNormKeys.has(gKey)) return;
      const stockItem = stockItems.find(s => normalizeKey(s.artist, s.album) === gKey);
      // Filtrer les pistes musicbee en priorité
      const mbT = (g.tracks || []).filter(t => !t.source || t.source === 'musicbee');
      const useT = mbT.length ? mbT : (g.tracks || []);
      useT.forEach(t => {
        if (!t.title) return;
        result.push({
          title: t.title, artist: g.artist, album: g.album || '',
          albumId: stockItem?.id || null,
          source: 'musicbee', bitrate: t.bitrate || null,
          duration: t.duration || null, play_count: t.play_count || null,
          inStock: true,
        });
        mbCount++;
      });
    });
  }

  // 3. Morceaux isolés
  tracks.forEach(t => {
    result.push({ title: t.title, artist: t.artist, album: t.album || '', albumId: null,
      source: 'isolated', bitrate: t.bitrate || null, duration: t.duration, play_count: null,
      inStock: false });
  });

  if (!mbCount && Object.keys(albumTracksCache).length) {
    const sources = new Set(Object.values(albumTracksCache).flat().map(t=>t.source));
    console.info('buildAllTracksList: sources dans cache =', [...sources]);
  }

  // Filet de sécurité bitrate : un même morceau (artiste+titre) peut apparaître plusieurs
  // fois dans result (version album + copie stock + entrée isolée...) et seule une de ces
  // occurrences porte un bitrate valide selon la source d'où elle vient. On propage la
  // valeur connue vers les occurrences du même morceau qui n'en ont pas, pour éviter un
  // "–" trompeur alors que le morceau a bien un bitrate connu ailleurs dans la collection.
  const bitrateByKey = new Map();
  result.forEach(t => {
    if (!t.bitrate) return;
    const k = normalizeKey(t.artist, t.title);
    const prev = bitrateByKey.get(k);
    if (!prev || t.bitrate > prev) bitrateByKey.set(k, t.bitrate);
  });
  result.forEach(t => {
    if (!t.bitrate) {
      const k = normalizeKey(t.artist, t.title);
      if (bitrateByKey.has(k)) t.bitrate = bitrateByKey.get(k);
    }
  });

  _cache.allTracksList = result;
  return result;
}

function renderAllTracks() {
  const q       = (document.getElementById('global-search').value||'').toLowerCase();
  const af      = (document.getElementById('filter-at-artist')?.value||'').toLowerCase().trim();
  const tf      = (document.getElementById('filter-at-title')?.value||'').toLowerCase().trim();
  const albf    = (document.getElementById('filter-at-album')?.value||'').toLowerCase().trim();
  const sf      = document.getElementById('filter-at-source')?.value||'';
  const folder  = document.getElementById('filter-at-folder')?.value||'';
  const nfOp    = document.getElementById('filter-at-note-op')?.value||'';
  const nfVal   = document.getElementById('filter-at-note-val')?.value||'';
  const minPlays= parseInt(document.getElementById('filter-at-min-plays')?.value||'0')||0;
  const lovedF  = document.getElementById('filter-at-loved')?.value||'';
  const bitrateF= document.getElementById('filter-at-bitrate')?.value||'';
  const sort    = document.getElementById('sort-at')?.value||'artist';
  const lfExact = getLfExactMap();

  if (!_cache.albumById)  _cache.albumById  = new Map(albums.map(a => [a.id, a]));
  if (!_cache.stockKeySet) _cache.stockKeySet = new Set(stockItems.map(s => normalizeKey(s.artist,s.album)));
  const albumById   = _cache.albumById;
  const stockKeySet = _cache.stockKeySet;

  // Index note MusicBee par clé normalisée (depuis albumTracksCache)
  if (!_cache.mbNoteByKey) {
    _cache.mbNoteByKey = new Map();
    albums.forEach(a => {
      const mbTracks = (albumTracksCache[a.id]||[]).filter(t=>t.source==='musicbee');
      const maxR = Math.max(0, ...mbTracks.map(t=>t.rating||0));
      if (maxR) _cache.mbNoteByKey.set(normalizeKey(a.artist, a.album), maxR);
    });
    tracks.forEach(t => { if (t.note) _cache.mbNoteByKey.set(normalizeKey(t.artist, t.title), t.note); });
  }

  const allTracks = buildAllTracksList();

  let list = allTracks.filter(t => {
    if (q && !(t.title+' '+t.artist+' '+t.album).toLowerCase().includes(q)) return false;
    if (af   && !t.artist.toLowerCase().includes(af))  return false;
    if (tf   && !t.title.toLowerCase().includes(tf))   return false;
    if (albf && !t.album.toLowerCase().includes(albf)) return false;
    if (sf) {
      if (sf === 'musicbee' && t.source !== 'musicbee') return false;
      if (sf === 'isolated' && t.source !== 'isolated') return false;
    }
    if (folder) {
      if (folder === 'isolated') {
        if (t.source !== 'isolated') return false;
      } else if (folder === 'stock') {
        const a = t.albumId ? albumById.get(t.albumId) : null;
        const isInStock = t.inStock || (a && stockKeySet.has(normalizeKey(a.artist, a.album)));
        if (!isInStock) return false;
      } else {
        const a = t.albumId ? albumById.get(t.albumId) : null;
        if (!a) return false;
        if (folder === 'discographie' && !(a.cd || a.flac || a.mp3)) return false;
        if (folder === 'ok'      && !a.okFolder) return false;
        if (folder === 'forsale' && !a.forSale)  return false;
        if (folder === 'discogs' && !a.cd)       return false;
      }
    }
    // Filtre note MB
    if (nfOp) {
      const note = t.note || _cache.mbNoteByKey.get(normalizeKey(t.artist, t.title)) || 0;
      if (!matchNoteFilter(nfOp, nfVal, note)) return false;
    }
    // Filtre écoutes min
    if (minPlays > 0 && (lfExact.get(normalizeKey(t.artist,t.title))||0) < minPlays) return false;
    // Filtre loved / scrobblé
    if (lovedF === 'loved'   && !_lovedTracks.has(normalizeKey(t.artist, t.title))) return false;
    if (lovedF === 'present' && !(lfExact.get(normalizeKey(t.artist, t.title))||0))  return false;
    // Filtre bitrate
    if (bitrateF === 'le320' && !(t.bitrate && t.bitrate <= 320)) return false;
    if (bitrateF === 'lt320' && !(t.bitrate && t.bitrate < 320))  return false;
    if (bitrateF === 'none'  && t.bitrate) return false;
    return true;
  });

  if (sort==='title')   list.sort((a,b)=>a.title.localeCompare(b.title,'fr'));
  else if (sort==='plays')   list.sort((a,b)=>(lfExact.get(normalizeKey(b.artist,b.title))||0)-(lfExact.get(normalizeKey(a.artist,a.title))||0));
  else if (sort==='note')    list.sort((a,b)=>(b.note||_cache.mbNoteByKey.get(normalizeKey(b.artist,b.title))||0)-(a.note||_cache.mbNoteByKey.get(normalizeKey(a.artist,a.title))||0));
  else if (sort==='bitrate') list.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
  else list.sort((a,b)=>a.artist.localeCompare(b.artist,'fr')||a.title.localeCompare(b.title,'fr'));

  const ctr = document.getElementById('at-counter');
  if (ctr) ctr.textContent = list.length.toLocaleString('fr-FR') + ' morceaux';
  const badge = document.getElementById('nav-all-tracks-count');
  if (badge) badge.textContent = allTracks.length.toLocaleString('fr-FR');

  const folderLabel = { album:'Album', stock:'Stock', ok:'Ok', forsale:'Vendre', isolated:'Top' };
  const tbody = document.getElementById('at-tbody');
  const slice = list.slice(0, 300);
  if (!slice.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="empty-icon">🎼</div>Aucun morceau</div></td></tr>'; return; }
  tbody.innerHTML = slice.map(t => {
    const plays = lfExact.get(normalizeKey(t.artist, t.title)) || 0;
    const note = t.note || _cache.mbNoteByKey.get(normalizeKey(t.artist, t.title)) || 0;
    const isLoved = _lovedTracks.has(normalizeKey(t.artist, t.title));
    const noteHtml = note
      ? [1,2,3,4,5].map(i=>`<span style="font-size:11px;color:${note>=i?'var(--amber)':'var(--border2)'}">★</span>`).join('')
      : '<span style="color:var(--text3);font-size:11px">–</span>';
    const srcBadge = t.inStock
      ? '<span class="badge badge-stock" style="font-size:10px">MB</span>'
      : t.source === 'musicbee'
        ? '<span class="badge badge-flac" style="font-size:10px">MB</span>'
        : '<span class="badge" style="font-size:10px;background:var(--purple-dim);color:var(--purple);border:1px solid rgba(176,140,255,0.2)">isolé</span>';
    const fol = t.inStock ? 'stock' : (() => {
      const a = t.albumId ? albumById.get(t.albumId) : null;
      if (!a) return t.source==='isolated' ? 'top' : '';
      if (a.forSale) return 'vendre';
      if (a.okFolder) return 'ok';
      if (a.cd) return 'discogs';
      return 'album';
    })();
    const folBadge = fol ? `<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">${fol}</span>` : '–';
    return `<tr>
      <td style="font-weight:500">${esc(t.title)}${isLoved ? ' <span style="font-size:11px" title="Lové sur last.fm">❤️</span>' : ''}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(t.artist)}</td>
      <td style="font-size:11px;color:var(--text3)">${esc(t.album||'–')}</td>
      <td>${srcBadge}</td>
      <td>${folBadge}</td>
      <td>${noteHtml}</td>
      <td class="mono" style="color:var(--accent);font-size:12px">${plays||'–'}</td>
      <td class="mono" style="font-size:11px;color:var(--text3)">${t.bitrate ? t.bitrate+'k' : '–'}</td>
    </tr>`;
  }).join('') + (list.length>300 ? `<tr><td colspan="8" style="text-align:center;color:var(--text3);font-size:12px;padding:10px">… ${(list.length-300).toLocaleString('fr-FR')} de plus — affinez les filtres</td></tr>` : '');
}

// ===================== ALBUM TRACKS VIEW =====================
function buildAlbumTracksList() {
  if (_cache.albumTracksList) return _cache.albumTracksList;
  const full = [];
  albums.forEach(a => {
    const atracks = albumTracksCache[a.id] || [];
    const mbT = atracks.filter(t => t.source === 'musicbee');
    const useT = mbT.length ? mbT : atracks.filter(t => t.source === 'discogs');
    useT.forEach(t => {
      const key = trackNoteKey(a.id, t.title);
      const rating = Object.prototype.hasOwnProperty.call(trackNoteOverrides, key) ? trackNoteOverrides[key] : (t.rating || 0);
      full.push({ title: t.title, artist: a.artist, album: a.album,
        source: t.source, bitrate: t.bitrate, duration: t.duration,
        play_count: t.play_count, rating });
    });
  });
  _cache.albumTracksList = full;
  return full;
}

function renderAlbumTracks() {
  const q       = (document.getElementById('global-search').value||'').toLowerCase();
  const af      = (document.getElementById('filter-abt-artist')?.value||'').toLowerCase().trim();
  const tf      = (document.getElementById('filter-abt-title')?.value||'').toLowerCase().trim();
  const albf    = (document.getElementById('filter-abt-album')?.value||'').toLowerCase().trim();
  const nf      = document.getElementById('filter-abt-note')?.value||'';
  const minPlays= parseInt(document.getElementById('filter-abt-min-plays')?.value||'0')||0;
  const lovedF  = document.getElementById('filter-abt-loved')?.value||'';
  const sort    = document.getElementById('sort-abt')?.value||'artist';
  const lfExact = getLfExactMap();

  const full = buildAlbumTracksList();

  let list = full.filter(t => {
    if (q && !(t.title+' '+t.artist+' '+t.album).toLowerCase().includes(q)) return false;
    if (af   && !t.artist.toLowerCase().includes(af))  return false;
    if (tf   && !t.title.toLowerCase().includes(tf))   return false;
    if (albf && !t.album.toLowerCase().includes(albf)) return false;
    if (nf) {
      const r = t.rating || 0;
      if (nf==='5' && r!==5) return false;
      if (nf==='4' && r<4)   return false;
      if (nf==='3' && r<3)   return false;
      if (nf==='0' && r>0)   return false;
    }
    if (minPlays > 0 && (lfExact.get(normalizeKey(t.artist,t.title))||0) < minPlays) return false;
    if (lovedF === 'loved'   && !_lovedTracks.has(normalizeKey(t.artist, t.title))) return false;
    if (lovedF === 'present' && !(lfExact.get(normalizeKey(t.artist, t.title))||0))  return false;
    return true;
  });

  if (sort==='title')        list.sort((a,b)=>a.title.localeCompare(b.title,'fr'));
  else if (sort==='plays')   list.sort((a,b)=>(lfExact.get(normalizeKey(b.artist,b.title))||0)-(lfExact.get(normalizeKey(a.artist,a.title))||0));
  else if (sort==='note')    list.sort((a,b)=>(b.rating||0)-(a.rating||0));
  else if (sort==='bitrate') list.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
  else list.sort((a,b)=>a.artist.localeCompare(b.artist,'fr')||a.album.localeCompare(b.album,'fr'));

  const ctr = document.getElementById('abt-counter');
  if (ctr) ctr.textContent = list.length.toLocaleString('fr-FR') + ' / ' + full.length.toLocaleString('fr-FR') + ' pistes';
  const badge = document.getElementById('nav-album-tracks-count');
  if (badge) badge.textContent = full.length.toLocaleString('fr-FR');

  const tbody = document.getElementById('abt-tbody');
  const slice = list.slice(0,300);
  if (!slice.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-icon">💿</div>Importez le XML MusicBee pour charger les pistes</div></td></tr>'; return; }
  tbody.innerHTML = slice.map(t => {
    const plays   = lfExact.get(normalizeKey(t.artist,t.title)) || 0;
    const isLoved = _lovedTracks.has(normalizeKey(t.artist, t.title));
    const noteHtml = t.rating
      ? [1,2,3,4,5].map(i=>`<span style="font-size:11px;color:${t.rating>=i?'var(--amber)':'var(--border2)'}">★</span>`).join('')
      : '<span style="color:var(--text3);font-size:11px">–</span>';
    return `<tr>
      <td style="font-weight:500">${esc(t.title)}${isLoved ? ' <span style="font-size:11px" title="Lové sur last.fm">❤️</span>' : ''}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(t.artist)}</td>
      <td style="font-size:11px;color:var(--text3)">${esc(t.album)}</td>
      <td>${noteHtml}</td>
      <td class="mono" style="color:var(--accent);font-size:12px">${plays||'–'}</td>
      <td class="mono" style="font-size:11px">${t.bitrate?t.bitrate+'k':'–'}</td>
      <td class="mono" style="font-size:11px;color:var(--text3)">${t.duration||'–'}</td>
    </tr>`;
  }).join('') + (list.length>300 ? `<tr><td colspan="7" style="text-align:center;color:var(--text3);font-size:12px;padding:10px">… ${(list.length-300).toLocaleString('fr-FR')} de plus</td></tr>` : '');
}

// ===================== TRACK WISHLIST =====================
let trackWishlist = [];

function openTrackWishModal(id) {
  const w = id ? trackWishlist.find(x=>x.id===id) : null;
  document.getElementById('tw-edit-id').value = id||'';
  document.getElementById('tw-f-artist').value = w?.artist||'';
  document.getElementById('tw-f-title').value  = w?.title ||'';
  document.getElementById('tw-f-album').value  = w?.album ||'';
  document.getElementById('tw-f-prio').value   = w?.prio  ||'mid';
  document.getElementById('modal-tw').classList.add('open');
}
function saveTrackWish() {
  const id     = document.getElementById('tw-edit-id').value;
  const artist = document.getElementById('tw-f-artist').value.trim();
  const title  = document.getElementById('tw-f-title').value.trim();
  const album  = document.getElementById('tw-f-album').value.trim();
  const prio   = document.getElementById('tw-f-prio').value;
  if (!artist||!title) { toast('Artiste et titre requis','error'); return; }
  if (id) { const w=trackWishlist.find(x=>x.id==id); if(w) Object.assign(w,{artist,title,album,prio}); }
  else trackWishlist.push({ id:uid(), artist, title, album, prio, addedAt:Date.now() });
  document.getElementById('modal-tw').classList.remove('open');
  renderTrackWishlist(); updateNavBadges(); saveToStorage();
}
function deleteTrackWish(id) {
  if (!confirm('Retirer de la wishlist morceaux ?')) return;
  trackWishlist = trackWishlist.filter(w=>w.id!==id);
  renderTrackWishlist(); updateNavBadges(); saveToStorage();
}
function renderTrackWishlist() {
  const q  = (document.getElementById('global-search').value||'').toLowerCase();
  const af = (document.getElementById('filter-tw-artist')?.value||'').toLowerCase().trim();
  const tf = (document.getElementById('filter-tw-title')?.value||'').toLowerCase().trim();
  const list = trackWishlist.filter(w =>
    (!q||`${w.artist} ${w.title}`.toLowerCase().includes(q))
    &&(!af||w.artist.toLowerCase().includes(af))
    &&(!tf||w.title.toLowerCase().includes(tf))
  ).sort((a,b)=>({high:0,mid:1,low:2}[a.prio]||1)-({high:0,mid:1,low:2}[b.prio]||1));
  const ctr=document.getElementById('tw-counter'); if(ctr) ctr.textContent=list.length+' morceaux';
  const badge=document.getElementById('nav-track-wish-count'); if(badge) badge.textContent=trackWishlist.length;
  const tbody=document.getElementById('tw-tbody');
  const prioL={high:'🔴 Haute',mid:'🟡 Moyenne',low:'🟢 Basse'};
  if (!list.length) { tbody.innerHTML='<tr><td colspan="5"><div class="empty"><div class="empty-icon">🎯</div>Wishlist morceaux vide.</div></td></tr>'; return; }
  tbody.innerHTML=list.map(w=>`<tr>
    <td style="font-weight:500">${esc(w.title)}</td>
    <td style="font-size:12px;color:var(--text2)">${esc(w.artist)}</td>
    <td style="font-size:11px;color:var(--text3)">${esc(w.album||'–')}</td>
    <td style="font-size:12px">${prioL[w.prio]||w.prio}</td>
    <td style="display:flex;gap:4px">
      <button class="btn btn-sm" onclick="openTrackWishModal(${w.id})">✎</button>
      <button class="btn btn-sm btn-danger" onclick="deleteTrackWish(${w.id})">✕</button>
    </td>
  </tr>`).join('');
}

// ===================== ASSOCIATIONS REVIEW =====================

let _assocRows = [];

function onAssocCheckChange() {
  const checks = document.querySelectorAll('.assoc-row-check:checked');
  const btn = document.getElementById('btn-delete-selected-assoc');
  if (btn) btn.style.display = checks.length ? '' : 'none';
  const all = document.getElementById('assoc-check-all');
  if (all) {
    const total = document.querySelectorAll('.assoc-row-check').length;
    all.indeterminate = checks.length > 0 && checks.length < total;
    all.checked = checks.length === total;
  }
}

function toggleAllAssoc(chk) {
  document.querySelectorAll('.assoc-row-check').forEach(c => c.checked = chk.checked);
  onAssocCheckChange();
}

function deleteSelectedAssoc() {
  const checked = [...document.querySelectorAll('.assoc-row-check:checked')];
  if (!checked.length) return;
  if (!confirm(`Supprimer ${checked.length} association${checked.length>1?'s':''} ?`)) return;
  const indices = checked.map(c => parseInt(c.dataset.idx));
  let removedCount = 0;
  // Traiter de la fin pour ne pas décaler les indices
  indices.sort((a,b)=>b-a).forEach(i => {
    const r = _assocRows[i];
    if (!r) return;
    if (r.type === 'discogs-num') {
      const before = associations.length;
      associations = associations.filter(a => !(a.cdKey === r.cdKey && a.numKey === r.numKey));
      if (associations.length !== before) removedCount++;
    } else if (r.type === 'rym') {
      const before = rymAssociations.length;
      rymAssociations = rymAssociations.filter(a => a.rymKey !== r.rymKey);
      if (rymAssociations.length !== before) removedCount++;
    } else if (r.type === 'lastfm') {
      const album = albums.find(a => a.id === r.albumId);
      if (album?.lastfmAliases && album.lastfmAliases.length > r.aliasIndex) {
        album.lastfmAliases.splice(r.aliasIndex, 1);
        removedCount++;
      }
    }
  });
  invalidateCache(); saveToStorage(); renderAssocReview(); updateNavBadges();
  toast(removedCount
    ? `${removedCount} association${removedCount>1?'s':''} supprimée${removedCount>1?'s':''}`
    : `Aucune association supprimée (déjà absente ?)`, removedCount ? 'success' : 'warn');
}

function renderAssocReview() {
  const typeF = document.getElementById('filter-assoc-type')?.value || '';
  const q = (document.getElementById('filter-assoc-q')?.value || '').toLowerCase().trim();
  // Le filtre "broken" doit parcourir tous les types puis ne garder que les cassées
  const wantBroken = typeF === 'broken';
  const effectiveTypeF = wantBroken ? '' : typeF;

  const rows = [];

  // 1. Associations Discogs ↔ Numérique
  if (!effectiveTypeF || effectiveTypeF === 'discogs-num') {
    associations.forEach((assoc, idx) => {
      const cdAlbum  = albumByKey(assoc.cdKey);
      const numAlbum = albumByKey(assoc.numKey);
      const broken = !cdAlbum || !numAlbum;
      if (wantBroken && !broken) return;
      const label = `${cdAlbum ? cdAlbum.artist + ' — ' + cdAlbum.album : '?'} ↔ ${numAlbum ? numAlbum.artist + ' — ' + numAlbum.album : '?'}`;
      if (q && !label.toLowerCase().includes(q)) return;
      rows.push({
        type: 'discogs-num',
        typeLabel: '💿 Discogs ↔ Numérique',
        broken,
        cdKey: assoc.cdKey, numKey: assoc.numKey,
        a: cdAlbum  ? `<strong>${esc(cdAlbum.album)}</strong><br><span style="font-size:11px;color:var(--text2)">${esc(cdAlbum.artist)}</span><br><span class="badge badge-cd">CD</span>` : `<span style="color:var(--red)">⚠️ Introuvable</span><br><span style="color:var(--text3);font-size:11px">${esc(assoc.cdKey)}</span>`,
        b: numAlbum ? `<strong>${esc(numAlbum.album)}</strong><br><span style="font-size:11px;color:var(--text2)">${esc(numAlbum.artist)}</span><br>${(numAlbum.format==='flac'||numAlbum.flac)?'<span class="badge badge-flac">FLAC</span>':''} ${(numAlbum.format==='mp3'||numAlbum.mp3)?'<span class="badge badge-mp3">MP3</span>':''}` : `<span style="color:var(--red)">⚠️ Introuvable</span><br><span style="color:var(--text3);font-size:11px">${esc(assoc.numKey)}</span>`,
        actions: `<button class="btn btn-sm btn-danger" onclick="removeDiscogsAssoc('${assoc.cdKey.replace(/'/g,"\\'")}','${assoc.numKey.replace(/'/g,"\\'")}')">✕</button>`
      });
    });
  }

  // 2. Associations RYM ↔ Album
  if (!effectiveTypeF || effectiveTypeF === 'rym') {
    rymAssociations.forEach(assoc => {
      const rymEntry = rymData.find(r => normalizeKey(r.artist, r.album) === assoc.rymKey);
      const album    = albumByKey(assoc.albumKey);
      const broken = !rymEntry || !album;
      if (wantBroken && !broken) return;
      const label = `${rymEntry ? rymEntry.artist + ' ' + rymEntry.album : assoc.rymKey} ${album ? album.artist + ' ' + album.album : ''}`;
      if (q && !label.toLowerCase().includes(q)) return;
      rows.push({
        type: 'rym',
        typeLabel: '⭐ RYM ↔ Album',
        broken,
        rymKey: assoc.rymKey,
        a: rymEntry
          ? `<strong>${esc(rymEntry.album)}</strong><br><span style="font-size:11px;color:var(--text2)">${esc(rymEntry.artist)}</span><br><span style="font-size:11px;color:var(--amber)">${rymEntry.rating ? rymEntry.rating.toFixed(2) + '★' : 'Non noté'}</span>`
          : `<span style="color:var(--red)">⚠️ Introuvable</span><br><span style="font-size:11px;color:var(--text3)">${esc(assoc.rymKey)}</span>`,
        b: album
          ? `<strong>${esc(album.album)}</strong><br><span style="font-size:11px;color:var(--text2)">${esc(album.artist)}</span>`
          : `<span style="color:var(--red)">⚠️ Introuvable (${esc(assoc.albumKey)})</span>`,
        actions: `<button class="btn btn-sm btn-danger" onclick="removeRYMAssoc('${assoc.rymKey.replace(/'/g,"\\'")}')">✕</button>
                  <button class="btn btn-sm" onclick="reassociateRYM('${assoc.rymKey.replace(/'/g,"\\'")}')">✎</button>`
      });
    });
  }

  // 3. Aliases last.fm
  // Un alias est "cassé" si l'album parent n'existe plus (rare, car indexé sur album.id directement)
  // ou si l'alias ne correspond plus à aucune entrée dans lastfmData (orphelin réel)
  if (!effectiveTypeF || effectiveTypeF === 'lastfm') {
    if (!_cache.lastfmKeysSet) _cache.lastfmKeysSet = new Set(lastfmData.map(d => normalizeKey(d.artist, d.album)));
    albums.forEach(album => {
      if (!album.lastfmAliases || !album.lastfmAliases.length) return;
      album.lastfmAliases.forEach((alias, ai) => {
        const broken = !_cache.lastfmKeysSet.has(alias);
        if (wantBroken && !broken) return;
        const label = album.artist + ' ' + album.album + ' ' + alias;
        if (q && !label.toLowerCase().includes(q)) return;
        rows.push({
          type: 'lastfm',
          typeLabel: '🎵 last.fm alias',
          broken,
          albumId: album.id, aliasIndex: ai,
          a: `<span style="font-size:12px;color:${broken?'var(--red)':'var(--text3)'};font-family:var(--mono)">${broken?'⚠️ ':''}${esc(alias)}</span>`,
          b: `<strong>${esc(album.album)}</strong><br><span style="font-size:11px;color:var(--text2)">${esc(album.artist)}</span>`,
          actions: `<button class="btn btn-sm btn-danger" onclick="removeLastfmAlias(${album.id},${ai})" title="Supprimer">✕</button>`
        });
      });
    });
  }

  const ctr = document.getElementById('assoc-counter');
  if (ctr) ctr.textContent = rows.length + ' association' + (rows.length > 1 ? 's' : '');

  // Badge nav
  const total = associations.length + rymAssociations.length + albums.reduce((s, a) => s + (a.lastfmAliases?.length || 0), 0);
  const badge = document.getElementById('nav-assoc-count');
  if (badge) badge.textContent = total;

  const tbody = document.getElementById('assoc-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty"><div class="empty-icon">🔗</div>Aucune association' + (q || typeF ? ' avec ces filtres' : ' enregistrée') + '.</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r,i) => `<tr>
    <td><input type="checkbox" class="assoc-row-check" data-idx="${i}" onchange="onAssocCheckChange()"></td>
    <td style="font-size:12px;color:var(--text2);white-space:nowrap">${r.typeLabel}</td>
    <td style="font-size:13px;line-height:1.5">${r.a}</td>
    <td style="font-size:13px;line-height:1.5">${r.b}</td>
    <td style="white-space:nowrap">${r.actions}</td>
  </tr>`).join('');
  _assocRows = rows; // stocker pour la suppression groupée

  // Filtre "Introuvables" actif : pré-cocher tout pour un nettoyage rapide en un clic
  if (wantBroken && rows.length) {
    document.querySelectorAll('.assoc-row-check').forEach(c => c.checked = true);
    onAssocCheckChange();
  }
}

  

function removeDiscogsAssoc(cdKey, numKey) {
  if (!confirm('Supprimer cette association Discogs ↔ Numérique ?')) return;
  associations = associations.filter(a => !(a.cdKey === cdKey && a.numKey === numKey));
  invalidateCache(); saveToStorage(); renderAssocReview(); updateNavBadges();
  toast('Association supprimée');
}

function addDiscogsAssocFrom(cdId) {
  // Ouvrir le modal d'association numérique pour un cdId donné
  const cdAlbum = albums.find(a => a.id === cdId);
  if (!cdAlbum) return;
  _assocTargetId = cdId;
  document.getElementById('assoc-target-title').textContent = cdAlbum.artist + ' — ' + cdAlbum.album;
  renderAssocList();
  document.getElementById('modal-assoc').classList.add('open');
}

function removeRYMAssoc(rymKey) {
  if (!confirm('Supprimer cette association RYM ?')) return;
  rymAssociations = rymAssociations.filter(a => a.rymKey !== rymKey);
  invalidateCache(); saveToStorage(); renderAssocReview(); renderRYM(); updateNavBadges();
  toast('Association RYM supprimée');
}

function reassociateRYM(rymKey) {
  const entry = rymData.find(r => normalizeKey(r.artist, r.album) === rymKey);
  if (!entry) return;
  // Supprimer l'ancienne et ouvrir le modal pour ré-associer
  rymAssociations = rymAssociations.filter(a => a.rymKey !== rymKey);
  openRYMAssocModal(rymKey, entry.artist, entry.album, entry.rating || 0);
}

function removeLastfmAlias(albumId, aliasIndex) {
  if (!confirm('Supprimer cet alias last.fm ?')) return;
  const album = albums.find(a => a.id === albumId);
  if (!album || !album.lastfmAliases) return;
  album.lastfmAliases.splice(aliasIndex, 1);
  invalidateCache(); saveToStorage(); renderAssocReview(); updateNavBadges();
  toast('Alias last.fm supprimé');
}

let _missingListCache = [];

function addToWishlistFromMissing(idx) {
  const m = _missingListCache[idx];
  if (!m) return;
  addToWishlist(m.artist, m.album, '', 'lastfm', m.plays, 0, '');
}
function addToWishlistFromRYMIdx(idx) {
  const r = _rymMissingCache[idx];
  if (!r) return;
  const plays = (lastfmData.find(d => normalizeKey(d.artist, d.album) === normalizeKey(r.artist, r.album)) || {}).plays || 0;
  addToWishlist(r.artist, r.album, r.year || '', 'rym', plays, r.rating || 0, '');
  renderRYM();
}
function addToWishlistFromAlbumId(albumId) {
  const realId = unsid(albumId);
  const a = albums.find(x => x.id === realId);
  if (!a) return;
  const rymR = (lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id))?.rating || 0;
  addToWishlist(a.artist, a.album, a.year || '', 'manual', a.plays || 0, rymR, '');
}

function addToWishlistFromStock(stockId) {
  const realId = unsid(stockId);
  const s = stockItems.find(x => x.id === realId || x.id === String(realId));
  if (!s) return;
  const rymR = (lookupRym(s.artist, s.album, s.id) || lookupRym(cleanDiscogsArtist(s.artist), s.album, s.id))?.rating || 0;
  addToWishlist(s.artist, s.album, s.year || '', 'stock', 0, rymR, s.notes || '');
}

function exportWishlistCSV() {
  const list = wishFilteredList();
  const prioLabel = { high: 'Haute', mid: 'Moyenne', low: 'Basse' };
  const srcLabel  = { lastfm: 'last.fm', stock: 'Stock', rym: 'RYM', discography: 'Discographie MB', manual: 'Manuel' };
  const rows = [['Artiste','Album','Année','Source','Priorité','Écoutes last.fm','Note MB','Note DC','Note RYM','Notes']];
  list.forEach(w => {
    const plays = wishPlays(w) || '';
    const owned = wishOwnedMatch(w);
    const rymEntry = wishRymEntry(w);
    rows.push([w.artist, w.album, w.year||'', srcLabel[w.source]||w.source,
      prioLabel[w.prio]||w.prio, plays, owned?.note||'', owned?.discogsRating||'', rymEntry?.rating||'', w.notes||'']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=`wishlist-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`${list.length} entrées exportées`);
}

// ===================== SÉLECTION MULTIPLE / ACTIONS GROUPÉES (Wishlist albums) =====================
let selectedWishIds = new Set();

function toggleWishSelected(id, checked) {
  if (checked) selectedWishIds.add(id); else selectedWishIds.delete(id);
  renderWishBulkBar();
}

function toggleSelectAllWish(checked) {
  document.querySelectorAll('#wish-tbody .row-select').forEach(cb => {
    cb.checked = checked;
    const id = parseInt(cb.dataset.id);
    if (checked) selectedWishIds.add(id); else selectedWishIds.delete(id);
  });
  renderWishBulkBar();
}

function clearWishSelection() {
  selectedWishIds.clear();
  document.querySelectorAll('#wish-tbody .row-select').forEach(cb => { cb.checked = false; });
  const selAllCb = document.getElementById('select-all-wish');
  if (selAllCb) selAllCb.checked = false;
  renderWishBulkBar();
}

function renderWishBulkBar() {
  const bar = document.getElementById('bulk-actions-bar-wish');
  const countEl = document.getElementById('bulk-actions-count-wish');
  if (!bar) return;
  const n = selectedWishIds.size;
  if (countEl) countEl.textContent = n ? `${n} entrée${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}` : '';
  bar.style.display = n ? 'flex' : 'none';
}

function bulkDeleteWish() {
  if (!selectedWishIds.size) return;
  const n = selectedWishIds.size;
  if (!confirm(`Retirer ${n} entrée(s) de la wishlist ?`)) return;
  wishlist = wishlist.filter(w => !selectedWishIds.has(w.id));
  clearWishSelection();
  renderWishlist();
  updateNavBadges();
  saveToStorage();
  toast(`${n} entrée(s) retirée(s) de la wishlist`);
}

function bulkSetWishPrio(prio) {
  if (!selectedWishIds.size) return;
  let n = 0;
  selectedWishIds.forEach(id => {
    const w = wishlist.find(x => x.id === id);
    if (!w) return;
    w.prio = prio;
    n++;
  });
  clearWishSelection();
  renderWishlist();
  saveToStorage();
  const prioLabel = { high: 'haute', mid: 'moyenne', low: 'basse' };
  toast(`Priorité ${prioLabel[prio]} appliquée à ${n} entrée(s)`);
}

// Note RYM live (pas de snapshot figé) — mêmes variantes artiste que la Collection
function wishRymEntry(w) {
  return lookupRym(w.artist, w.album) || lookupRym(cleanDiscogsArtist(w.artist), w.album);
}
// Fiche déjà possédée correspondant à cette entrée wishlist (ex : vinyle en collection,
// CD recherché) — sert à afficher les notes MB/DC déjà connues plutôt que de les
// dupliquer/re-saisir.
function wishOwnedMatch(w) {
  const key = normalizeKey(w.artist, w.album);
  return albums.find(a => normalizeKey(a.artist, a.album) === key || normalizeKey(cleanDiscogsArtist(a.artist), a.album) === key);
}
// Écoutes last.fm live (pas le snapshot w.plays figé à l'ajout — même bug que la note RYM
// corrigée en v2026.07.10-02 : les 3 chemins d'ajout wishlist figent plays au moment T,
// jamais remis à jour ensuite même si de nouveaux scrobbles arrivent ou si l'album est
// désormais possédé avec ses écoutes réelles en Collection). exportWishlistCSV() faisait
// déjà ce lookup live via lfIndex — seul l'affichage écran restait sur l'ancien snapshot.
function wishPlays(w) {
  const entry = lastfmData.find(d => normalizeKey(d.artist, d.album) === normalizeKey(w.artist, w.album))
    || lastfmData.find(d => normalizeKey(cleanDiscogsArtist(d.artist), d.album) === normalizeKey(w.artist, w.album));
  return entry ? entry.plays : (w.plays || 0);
}

// Filtres combinés Wishlist (recherche/artiste/album/source/priorité/année) — réutilisée par
// renderWishlist() et exportWishlistCSV(). Pas de filtre genre : les entrées wishlist ne portent
// pas ce champ dans le modèle actuel (aucune source ne le fournit à l'ajout).
function wishFilteredList() {
  const q    = document.getElementById('global-search').value.toLowerCase();
  const af   = (document.getElementById('filter-wish-artist')?.value || '').toLowerCase().trim();
  const albf = (document.getElementById('filter-wish-album')?.value  || '').toLowerCase().trim();
  const sf   = document.getElementById('filter-wish-source')?.value || '';
  const pf   = document.getElementById('filter-wish-prio')?.value   || '';
  const yf   = (document.getElementById('filter-wish-year')?.value  || '').trim();

  return wishlist.filter(w => {
    return (!q    || (w.artist+' '+w.album).toLowerCase().includes(q))
        && (!af   || w.artist.toLowerCase().includes(af))
        && (!albf || w.album.toLowerCase().includes(albf))
        && (!sf   || w.source === sf)
        && (!pf   || w.prio   === pf)
        && (!yf   || (w.year||'').startsWith(yf));
  }).sort((a, b) => {
    const po = { high: 0, mid: 1, low: 2 };
    if (po[a.prio] !== po[b.prio]) return po[a.prio] - po[b.prio];
    return wishPlays(b) - wishPlays(a);
  });
}

function renderWishlist() {
  if (!_restoringSnapshot) pruneWishlistOwned();
  const list = wishFilteredList();

  const ctr = document.getElementById('wish-counter');
  if (ctr) ctr.textContent = list.length + ' / ' + wishlist.length + ' entrées';

  const tbody = document.getElementById('wish-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty"><div class="empty-icon">🎯</div>' +
      (wishlist.length ? 'Aucun résultat avec ces filtres.' : 'La wishlist est vide. Ajoutez des albums depuis last.fm, RYM ou le stock.') +
      '</div></td></tr>';
    renderWishBulkBar();
    return;
  }
  const prioLabel = { high: '🔴 Haute', mid: '🟡 Moyenne', low: '🟢 Basse' };
  const srcLabel  = { lastfm: '🎵 last.fm', stock: '📦 Stock', rym: '⭐ RYM', discography: '🎼 Discographie MB', manual: '✍️ Manuel' };
  tbody.innerHTML = list.map(w => {
    // Note RYM : lookup live (pas le snapshot rymRating figé à l'ajout — cf. bug
    // "note RYM absente en wishlist alors qu'elle existe" côté ajout manuel/stock,
    // qui n'appelait jamais lookupRym et laissait rymRating à 0).
    const rymEntry = wishRymEntry(w);
    // Notes MB (MusicBee) / DC (Discogs) : uniquement si l'album correspond déjà à une
    // fiche possédée (ex : vinyle en collection, CD en wishlist) — cas fréquent vu le
    // fonctionnement "à acquérir dans un autre format" de cette wishlist.
    const owned = wishOwnedMatch(w);
    return `<tr>
    <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="${w.id}" ${selectedWishIds.has(w.id) ? 'checked' : ''} onchange="toggleWishSelected(${w.id}, this.checked)"></td>
    <td>
      <div style="font-weight:500">${esc(w.album)}</div>
      <div style="font-size:12px;color:var(--text2)">${artistLink(w.artist)}</div>
    </td>
    <td class="mono">${w.year || '–'}</td>
    <td style="font-size:12px">${srcLabel[w.source] || w.source}</td>
    <td><span style="font-size:12px">${prioLabel[w.prio] || w.prio}</span></td>
    <td class="mono" style="color:var(--accent)">${wishPlays(w) || '–'}</td>
    <td class="mono">${owned?.note ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${owned.note.toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : '<span style="color:var(--text3);font-size:11px">–</span>'}</td>
    <td class="mono">${owned?.discogsRating ? `<span style="font-family:var(--mono);font-size:12px;color:var(--blue)">${Number(owned.discogsRating).toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : '<span style="color:var(--text3);font-size:11px">–</span>'}</td>
    <td class="mono" style="color:var(--amber)">${rymEntry?.rating ? rymEntry.rating.toFixed(2) + '★' : '–'}</td>
    <td style="display:flex;gap:4px">
      <button class="btn btn-sm" onclick="openWishModal(${w.id})" title="Modifier">✎</button>
      <button class="btn btn-sm btn-danger" onclick="deleteWish(${w.id})" title="Supprimer">✕</button>
    </td>
  </tr>`;
  }).join('');
  renderWishBulkBar();
  const selAllCb = document.getElementById('select-all-wish');
  if (selAllCb) selAllCb.checked = list.length > 0 && list.every(w => selectedWishIds.has(w.id));
}

// ===================== STOCK =====================
let _stockNote = 0;

function openStockModal(id) {
  _stockNote = 0;
  const realId = id ? unsid(id) : null;
  document.getElementById('s-edit-id').value = realId || '';
  document.getElementById('modal-stock-title').textContent = realId ? 'Modifier' : 'Ajouter au stock';
  if (realId) {
    const s = stockItems.find(x => x.id === realId);
    if (s) {
      document.getElementById('s-artist').value = s.artist;
      document.getElementById('s-album').value = s.album;
      document.getElementById('s-year').value = s.year || '';
      document.getElementById('s-genre').value = s.genre || '';
      document.getElementById('s-format').value = s.format || 'flac';
      document.getElementById('s-notes').value = s.notes || '';
      _stockNote = s.note || 0;
    }
  } else {
    ['s-artist','s-album','s-year','s-genre','s-notes'].forEach(f => document.getElementById(f).value = '');
    document.getElementById('s-format').value = 'flac';
  }
  document.querySelectorAll('#stock-modal-stars .modal-star').forEach((s,i) => s.classList.toggle('on', i < _stockNote));
  document.getElementById('modal-stock').classList.add('open');
}

function closeStockModal() { document.getElementById('modal-stock').classList.remove('open'); }

function setStockNote(n) {
  _stockNote = n;
  document.querySelectorAll('#stock-modal-stars .modal-star').forEach((s,i) => s.classList.toggle('on', i < n));
}

function saveStockItem() {
  const artist = document.getElementById('s-artist').value.trim();
  const album = document.getElementById('s-album').value.trim();
  if (!artist || !album) { toast('Artiste et album requis', 'error'); return; }
  const eid = parseInt(document.getElementById('s-edit-id').value) || null;
  const data = {
    artist, album,
    year: document.getElementById('s-year').value.trim(),
    genre: document.getElementById('s-genre').value.trim(),
    format: document.getElementById('s-format').value,
    notes: document.getElementById('s-notes').value.trim(),
    note: _stockNote,
    addedAt: new Date().toISOString(),
  };
  if (eid) {
    const idx = stockItems.findIndex(x => x.id === eid);
    if (idx !== -1) stockItems[idx] = { ...stockItems[idx], ...data };
    toast('Mis à jour ✓');
  } else {
    stockItems.push({ id: uid(), ...data });
    toast('Ajouté au stock ✓');
  }
  invalidateCache(); // stockKeysSet doit être recalculé
  closeStockModal();
  renderStock();
  saveToStorage();
}

// deleteStockItem supprimée (v2026.07.10-03) — idem.

function moveStockToCollection(id) {
  const realId = unsid(id);
  const s = stockItems.find(x => x.id === realId || x.id === String(realId));
  if (!s) return;
  const fmt = s.format || 'flac';
  albums.push({
    id: uid(), artist: s.artist, album: s.album, year: s.year || '', genre: s.genre || '',
    cd: false, flac: fmt === 'flac', mp3: fmt === 'mp3', digital: fmt === 'digital' || fmt === 'autre',
    note: s.note || 0, plays: 0, notes: s.notes || ''
  });
  stockItems = stockItems.filter(x => x.id !== realId);
  selectedStockIds.delete(realId);
  invalidateCache();
  renderStock();
  saveToStorage();
  toast(`"${s.album}" déplacé vers la collection ✓`);
}

// ===================== SÉLECTION MULTIPLE / ACTIONS GROUPÉES (Stock) =====================
let selectedStockIds = new Set();

function toggleStockSelected(idSid, checked) {
  const id = unsid(idSid);
  const s = stockItems.find(x => x.id === id || x.id === String(id));
  const realId = s ? s.id : id;
  if (checked) selectedStockIds.add(realId); else selectedStockIds.delete(realId);
  renderStockBulkBar();
}

function toggleSelectAllStock(checked) {
  document.querySelectorAll('#stock-tbody .row-select').forEach(cb => {
    cb.checked = checked;
    const id = unsid(cb.dataset.id);
    const s = stockItems.find(x => x.id === id || x.id === String(id));
    const realId = s ? s.id : id;
    if (checked) selectedStockIds.add(realId); else selectedStockIds.delete(realId);
  });
  renderStockBulkBar();
}

function clearStockSelection() {
  selectedStockIds.clear();
  document.querySelectorAll('#stock-tbody .row-select').forEach(cb => { cb.checked = false; });
  const selAllCb = document.getElementById('select-all-stock');
  if (selAllCb) selAllCb.checked = false;
  renderStockBulkBar();
}

function renderStockBulkBar() {
  const bar = document.getElementById('bulk-actions-bar-stock');
  const countEl = document.getElementById('bulk-actions-count-stock');
  if (!bar) return;
  const n = selectedStockIds.size;
  if (countEl) countEl.textContent = n ? `${n} album${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}` : '';
  bar.style.display = n ? 'flex' : 'none';
}

// bulkDeleteStock supprimée (v2026.07.10-03) — idem.

function bulkAddToWishlistFromStock() {
  if (!selectedStockIds.size) return;
  let added = 0, skipped = 0;
  selectedStockIds.forEach(id => {
    const s = stockItems.find(x => x.id === id || x.id === String(id));
    if (!s) return;
    const key = normalizeKey(s.artist, s.album);
    if (wishlist.find(w => normalizeKey(w.artist, w.album) === key)) { skipped++; return; }
    addToWishlist(s.artist, s.album, s.year || '', 'stock', 0, 0, s.notes || '');
    added++;
  });
  clearStockSelection();
  renderStock();
  toast(`${added} album(s) ajouté(s) à la wishlist${skipped ? ` — ${skipped} déjà présent(s)` : ''}`);
}

function bulkMoveStockToCollection() {
  if (!selectedStockIds.size) return;
  const n = selectedStockIds.size;
  if (!confirm(`Déplacer ${n} album(s) du stock vers la collection ?`)) return;
  let moved = 0;
  selectedStockIds.forEach(id => {
    const s = stockItems.find(x => x.id === id || x.id === String(id));
    if (!s) return;
    const fmt = s.format || 'flac';
    albums.push({
      id: uid(), artist: s.artist, album: s.album, year: s.year || '', genre: s.genre || '',
      cd: false, flac: fmt === 'flac', mp3: fmt === 'mp3', digital: fmt === 'digital' || fmt === 'autre',
      note: s.note || 0, plays: 0, notes: s.notes || ''
    });
    moved++;
  });
  stockItems = stockItems.filter(s => !selectedStockIds.has(s.id) && !selectedStockIds.has(String(s.id)));
  invalidateCache();
  clearStockSelection();
  renderStock();
  renderAlbums();
  saveToStorage();
  toast(`${moved} album(s) déplacé(s) vers la collection ✓`);
}

// Filtres combinés Stock (recherche/artiste/genre/année/note) — réutilisée par renderStock() et exportStockCSV()
function stockFilteredList() {
  const q = document.getElementById('global-search').value.toLowerCase();
  const af = document.getElementById('filter-stock-artist')?.value || '';
  const gf = document.getElementById('filter-stock-genre')?.value || '';
  const yf = (document.getElementById('filter-stock-year')?.value || '').trim();
  const nfOp = document.getElementById('filter-stock-note-op')?.value || '';
  const nfVal = document.getElementById('filter-stock-note-val')?.value || '';
  return stockItems.filter(s => {
    const m = !q || (s.artist + ' ' + s.album).toLowerCase().includes(q);
    const am = !af || s.artist === af;
    const gm = !gf || s.genre === gf;
    const ym = !yf || (s.year||'').startsWith(yf);
    const nm = matchNoteFilter(nfOp, nfVal, s.note || 0);
    return m && am && gm && ym && nm;
  }).sort((a, b) => a.artist.localeCompare(b.artist, 'fr'));
}

function renderStock() {
  // updateNavBadges called by saveToStorage
  let list = stockFilteredList();

  // Update artist filter
  const artists = [...new Set(stockItems.map(s => s.artist).filter(Boolean))].sort((a,b) => a.localeCompare(b,'fr'));
  const selA = document.getElementById('filter-stock-artist');
  const curA = selA?.value || '';
  if (selA) selA.innerHTML = '<option value="">Tous artistes</option>' + artists.map(a => `<option value="${esc(a)}" ${a===curA?'selected':''}>${esc(a)}</option>`).join('');

  // Update genre filter
  const genres = [...new Set(stockItems.map(s => s.genre).filter(Boolean))].sort();
  const selG = document.getElementById('filter-stock-genre');
  const curG = selG?.value || '';
  if (selG) selG.innerHTML = '<option value="">Tous genres</option>' + genres.map(g => `<option value="${esc(g)}" ${g===curG?'selected':''}>${esc(g)}</option>`).join('');

  const tbody = document.getElementById('stock-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-icon">📦</div>Aucun album en stock</div></td></tr>';
    renderStockBulkBar();
    return;
  }

  const fmtBadge = { flac: 'badge-flac', mp3: 'badge-mp3', digital: 'badge-digital', autre: 'badge-digital' };
  const stars = s => [1,2,3,4,5].map(i =>
    `<button class="star ${(s.note||0)>=i?'on':''}" onclick="rateStock('${s.id}',${i});event.stopPropagation()">★</button>`
  ).join('');

  tbody.innerHTML = list.map(s => `
    <tr onclick="openStockModal('${sid(s.id)}')" style="cursor:pointer">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="${sid(s.id)}" ${selectedStockIds.has(s.id) ? 'checked' : ''} onchange="toggleStockSelected('${sid(s.id)}', this.checked)"></td>
      <td>
        <div class="artist-cell">
          <div class="artist-avatar">${initials(s.artist)}</div>
          <div class="artist-info">
            <div class="name">${esc(s.album)}</div>
            <div class="sub">${esc(s.artist)}</div>
          </div>
        </div>
      </td>
      <td class="mono">${s.year || '–'}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(s.genre||'–')}</td>
      <td><span class="badge ${fmtBadge[s.format]||'badge-digital'}">${(s.format||'?').toUpperCase()}</span></td>
      <td><div class="stars">${stars(s)}</div></td>
      <td onclick="event.stopPropagation()" style="display:flex;gap:4px">
        <button class="btn btn-sm" onclick="moveStockToCollection('${sid(s.id)}')" title="Déplacer vers la collection">→ Collecter</button>
        <button class="btn btn-sm" onclick="addToWishlistFromStock('${sid(s.id)}')" title="Ajouter à la wishlist">🎯</button>
      </td>
    </tr>`).join('');
  renderStockBulkBar();
  const selAllCb = document.getElementById('select-all-stock');
  if (selAllCb) selAllCb.checked = list.length > 0 && list.every(s => selectedStockIds.has(s.id));
}

function rateStock(id, note) {
  const realId = unsid(id);
  const s = stockItems.find(x => x.id === realId || x.id === String(realId));
  if (s) {
    s.note = s.note === note ? 0 : note;
    renderStock();
    if (document.getElementById('filter-support')?.value === 'stock') renderAlbums();
    saveToStorage();
  }
}

function exportStockCSV() {
  const list = stockFilteredList();
  const header = ['id','artist','album','year','genre','format','note','notes'];
  const rows = [header.join(','), ...list.map(s => toCSVRow([s.id,s.artist,s.album,s.year||'',s.genre||'',s.format||'',s.note||0,s.notes||'']))];
  download('discothèque_stock.csv', rows.join('\n'), 'text/csv');
  toast(`${list.length} album(s) exporté(s) ✓`);
}

document.getElementById('modal-stock').addEventListener('click', function(e) {
  if (e.target === this) closeStockModal();
});

// ===================== DISCOGRAPHIE =====================

function getLinkedNumKeys(cdKey) {
  // cdKey transmis ici est toujours normalizeKey(artist, album) (cf. hasDigitalBackup).
  // Mais a.cdKey stocké dans associations[] est souvent l'id réel de l'album CD
  // (entier uid() pour les imports Discogs/manuels), pas forcément égal à cdKey.
  // On résout donc chaque association vers son album CD réel et on compare les deux formes.
  return associations
    .filter(a => {
      if (a.cdKey === cdKey || String(a.cdKey) === String(cdKey)) return true;
      const cdAlbum = albumByKey(a.cdKey);
      return cdAlbum && normalizeKey(cdAlbum.artist, cdAlbum.album) === cdKey;
    })
    .map(a => a.numKey);
}
function getLinkedNumKey(cdKey) {
  return getLinkedNumKeys(cdKey)[0] || null;
}

// Compat : retrouver l'album à partir d'une clé texte
function albumByKey(key) {
  return albums.find(a => a.id === key || String(a.id) === String(key) || normalizeKey(a.artist, a.album) === key);
}

// Un album a une sauvegarde numérique si :
// - il a flac/mp3/digital coché sur lui-même
// - OU il est associé manuellement à un autre album numérique
// - OU un autre album partage le même normalizeKey et est numérique
// Cache de lookup : Set des clés numériques pour éviter O(n²)
function getDigitalKeysSet() {
  if (_cache.digitalKeysSet) return _cache.digitalKeysSet;
  _cache.digitalKeysSet = new Set();
  albums.filter(a => a.flac || a.mp3 || a.digital).forEach(a => {
    // Indexer avec toutes les variantes artiste pour maximiser les rapprochements
    for (const av of artistVariants(a.artist)) {
      _cache.digitalKeysSet.add(av + '|||' + normalizeKey('', a.album).replace('|||', ''));
    }
    // Aussi la clé standard complète
    _cache.digitalKeysSet.add(normalizeKey(a.artist, a.album));
    _cache.digitalKeysSet.add(normalizeKey(cleanDiscogsArtist(a.artist), a.album));
  });
  return _cache.digitalKeysSet;
}

function getCDKeysSet() {
  if (_cache.cdKeysSet) return _cache.cdKeysSet;
  _cache.cdKeysSet = new Set();
  albums.filter(a => a.cd).forEach(a => {
    _cache.cdKeysSet.add(normalizeKey(a.artist, a.album));
    for (const av of artistVariants(a.artist)) {
      _cache.cdKeysSet.add(av + '|||' + normalizeKey('', a.album).replace('|||', ''));
    }
  });
  return _cache.cdKeysSet;
}

function hasDigitalBackup(album) {
  if (album.format || album.flac || album.mp3 || album.digital) return true;
  // Vérifier les associations manuelles — la clé utilisée dans associations[]
  // est toujours album.id (cf. applyAssociation / openAssocModal), PAS normalizeKey(artist,album).
  // Pour les CDs Discogs, id est un entier (uid()) ≠ normalizeKey — il faut chercher sous a.id.
  const linkedKeys = getLinkedNumKeys(String(album.id));
  for (const lk of linkedKeys) {
    const linked = albumByKey(lk);
    if (linked && (linked.format || linked.flac || linked.mp3 || linked.digital)) return true;
  }
  // Vérifier via getDigitalKeysSet (index de tous les numériques)
  const digitalKeys = getDigitalKeysSet();
  const albumNorm = normalizeKey('', album.album).replace('|||', '');
  for (const av of artistVariants(album.artist)) {
    if (digitalKeys.has(av + '|||' + albumNorm)) return true;
  }
  return false;
}

// Liste des CDs Discogs sans aucune sauvegarde numérique
function getCDsWithoutBackup() {
  if (_cache.cdsWithoutBackup) return _cache.cdsWithoutBackup;
  _cache.cdsWithoutBackup = albums.filter(a => a.cd && !hasDigitalBackup(a));
  return _cache.cdsWithoutBackup;
}

// Liste des entrées numériques sans CD Discogs correspondant
function getNumericWithoutCD() {
  if (_cache.numericWithoutCD) return _cache.numericWithoutCD;
  const cdKeys = getCDKeysSet();
  // linkedNumKeys doit couvrir numKey tel que stocké (souvent a.id, qui peut être
  // un entier uid() pour les albums ajoutés via Discogs/manuel, PAS forcément
  // égal à normalizeKey(artist, album)). On indexe donc par id ET par clé normalisée.
  const linkedNumKeys = new Set();
  associations.forEach(a => {
    linkedNumKeys.add(String(a.numKey));
    const linkedAlbum = albumByKey(a.numKey);
    if (linkedAlbum) {
      linkedNumKeys.add(String(linkedAlbum.id));
      linkedNumKeys.add(normalizeKey(linkedAlbum.artist, linkedAlbum.album));
    }
  });
  _cache.numericWithoutCD = albums
    .filter(a => {
      // Exclure explicitement les albums stock et les dossiers non-discographie
      if (a.primaryFolder === 'stock')   return false;
      if (a.primaryFolder === 'ok')      return false;
      if (a.primaryFolder === 'forsale') return false;
      // Doit avoir un format numérique et pas de CD
      if (!a.format && !a.flac && !a.mp3 && !a.digital) return false;
      if (a.has_cd || a.cd) return false;
      return true;
    })
    .filter(a => {
      const albumNorm = normalizeKey('', a.album).replace('|||', '');
      const aKey = normalizeKey(a.artist, a.album);
      if (linkedNumKeys.has(String(a.id)) || linkedNumKeys.has(aKey)) return false;
      for (const av of artistVariants(a.artist)) {
        if (cdKeys.has(av + '|||' + albumNorm)) return false;
      }
      return true;
    });
  return _cache.numericWithoutCD;
}

function discoFilteredList() {
  const filter = document.getElementById('disco-filter')?.value || 'all';
  const typeFilter = document.getElementById('disco-filter-type')?.value || '';
  const sort = document.getElementById('disco-sort')?.value || 'artist';
  const q = document.getElementById('global-search').value.toLowerCase();
  const stockKeys = getStockKeysSet();
  const af       = (document.getElementById('filter-disco-artist')?.value || '').toLowerCase().trim();
  const albf     = (document.getElementById('filter-disco-album')?.value  || '').toLowerCase().trim();
  const genreF   = document.getElementById('filter-disco-genre')?.value   || '';
  const noteOp   = document.getElementById('filter-disco-note-op')?.value  || '';
  const noteVal  = document.getElementById('filter-disco-note-val')?.value || '';
  const dcOp     = document.getElementById('filter-disco-dc-op')?.value    || '';
  const dcVal    = document.getElementById('filter-disco-dc-val')?.value   || '';
  const rymOp    = document.getElementById('filter-disco-rym-op')?.value   || '';
  const rymVal   = document.getElementById('filter-disco-rym-val')?.value  || '';
  const minPlays = parseInt(document.getElementById('filter-disco-min-plays')?.value || '0') || 0;

  // Détecte une compilation (Various Artists / Various) — MB (secondary-types "Compilation")
  // fait foi quand disponible (todo section 6, "distinguer automatiquement les compils sans
  // heuristique manuelle"), sinon repli sur l'heuristique regex existante.
  const isVA = a => a.mb_release_secondary_types?.length
    ? a.mb_release_secondary_types.includes('Compilation')
    : (/^various/i.test(a.artist) || a.isCompilation);
  // Détecte un EP / single / rarités / live / compilation de titres — idem, MB
  // (primary-type EP/Single, ou secondary-types Live/Remix/DJ-mix/Mixtape) fait foi quand
  // disponible, sinon repli sur la même heuristique regex qu'avant.
  const EP_RE = /\b(EP|single|b[\-\s]?sides?|bonus|raret[eé]s?|best\s+of|collection|sampler|vol\.?|volume|#\d|\bcd\s*\d|\blive\b|bootleg|demo|anthology|greatest\s+hits|the\s+singles|box\s+set)\b/i;
  const MB_EP_SECONDARY = ['Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo'];
  const isEP = a => (a.mb_release_type || a.mb_release_secondary_types?.length)
    ? (['EP', 'Single'].includes(a.mb_release_type) || a.mb_release_secondary_types?.some(t => MB_EP_SECONDARY.includes(t)))
    : (EP_RE.test(a.album) || /^\[/.test(a.album));

  let list = [];
  if (filter === 'no-cd') {
    list = getNumericWithoutCD().filter(a => !a.okFolder && !a.forSale);
  } else {
    // Construire le Set des numKeys associés pour masquer les doublons liés
    const linkedNumKeySet = new Set(associations.map(a => String(a.numKey)));
    list = albums.filter(a => {
      // Exclure les entrées numériques-sans-CD qui sont déjà liées à un CD via associations[]
      // (elles sont représentées par leur entrée CD, les afficher en double crée de la confusion)
      if (!(a.cd || a.has_cd) && linkedNumKeySet.has(String(a.id))) return false;
      return (a.cd || a.has_cd || a.folders?.includes('discographie'))
      && !stockKeys.has(normalizeKey(a.artist, a.album))
      && !a.okFolder
      && !a.forSale;
    });
    if (filter === 'missing') list = list.filter(a => !hasDigitalBackup(a));
    if (filter === 'ok') list = list.filter(a => hasDigitalBackup(a));
  }

  // Filtre par type
  if (typeFilter === 'no-va')   list = list.filter(a => !isVA(a));
  if (typeFilter === 'va')      list = list.filter(a => isVA(a));
  if (typeFilter === 'no-ep')   list = list.filter(a => !isEP(a));
  if (typeFilter === 'studio')  list = list.filter(a => !isVA(a) && !isEP(a));

  // Filtres texte + genre
  if (q)     list = list.filter(a => (a.artist + ' ' + a.album).toLowerCase().includes(q));
  if (af)    list = list.filter(a => a.artist.toLowerCase().includes(af));
  if (albf)  list = list.filter(a => a.album.toLowerCase().includes(albf));
  if (genreF)list = list.filter(a => a.genre === genreF);

  // Filtre année
  const discoYearF = (document.getElementById('filter-disco-year')?.value || '').trim();
  if (discoYearF) list = list.filter(a => (a.year||'').startsWith(discoYearF));

  // Filtre note MB
  if (noteOp) list = list.filter(a => matchNoteFilter(noteOp, noteVal, a.note || 0));

  // Filtre note Discogs
  if (dcOp) list = list.filter(a => matchNoteFilter(dcOp, dcVal, a.discogsRating || 0));

  // Filtre note RYM
  if (rymOp) list = list.filter(a => {
    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    return matchNoteFilter(rymOp, rymVal, rymEntry?.rating || 0);
  });

  // Filtre écoutes min
  if (minPlays > 0) list = list.filter(a => (a.plays || 0) >= minPlays);

  // Mettre à jour le select genre
  const genreSel = document.getElementById('filter-disco-genre');
  if (genreSel && genreSel.options.length <= 1) {
    const genres = [...new Set(albums
      .filter(a => a.cd || a.has_cd || a.folders?.includes('discographie'))
      .map(a => a.genre).filter(Boolean))].sort();
    genres.forEach(g => {
      const o = document.createElement('option'); o.value = g; o.textContent = g;
      genreSel.appendChild(o);
    });
  }

  return [...list].sort((a, b) => {
    if (sort === 'year')  return (b.year || 0) - (a.year || 0);
    if (sort === 'album') return (a.album || '').localeCompare(b.album || '', 'fr');
    if (sort === 'note')  return (b.note || 0) - (a.note || 0);
    if (sort === 'dc')    return (b.discogsRating || 0) - (a.discogsRating || 0);
    if (sort === 'rym')   {
      const ra = (lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id))?.rating || 0;
      const rb = (lookupRym(b.artist, b.album, b.id) || lookupRym(cleanDiscogsArtist(b.artist), b.album, b.id))?.rating || 0;
      return rb - ra;
    }
    if (sort === 'plays') return (b.plays || 0) - (a.plays || 0);
    return (a.artist || '').localeCompare(b.artist || '', 'fr');
  });
}

function renderDiscographie() {
  const stockKeys = getStockKeysSet();
  const discoOnly = albums.filter(a => a.cd && !stockKeys.has(normalizeKey(a.artist, a.album)) && !a.okFolder && !a.forSale);
  const saved = discoOnly.filter(a => hasDigitalBackup(a));
  const missingNum = discoOnly.filter(a => !hasDigitalBackup(a));
  const noCD = getNumericWithoutCD().filter(a => !a.okFolder && !a.forSale);

  document.getElementById('disco-total').textContent = discoOnly.length;
  document.getElementById('disco-saved').textContent = saved.length;
  document.getElementById('disco-missing-num').textContent = missingNum.length;
  document.getElementById('disco-missing-cd').textContent = noCD.length;

  const list = discoFilteredList();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (discoPage > pages) discoPage = pages;
  const slice = list.slice((discoPage - 1) * PAGE_SIZE, discoPage * PAGE_SIZE);

  const tbody = document.getElementById('disco-tbody');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty"><div class="empty-icon">📀</div>Aucune entrée</div></td></tr>';
    document.getElementById('disco-page-info').textContent = '';
  // updateNavBadges called by saveToStorage
    renderBulkActionsBar();
    return;
  }

  const filter = document.getElementById('disco-filter')?.value || 'all';

  tbody.innerHTML = slice.map(a => {
    const isCD = !!(a.cd || a.has_cd);
    const isDigital = !!(a.format || a.flac || a.mp3 || a.digital);
    const hasNum = hasDigitalBackup(a);
    // Associations : clés texte stables
    const aKey = String(a.id); // id peut être entier (Discogs uid) ou texte (normalizeKey)
    const linkedKeys = getLinkedNumKeys(aKey);
    const linked = linkedKeys.length ? albumByKey(linkedKeys[0]) : null;

    // Statut
    let statusBadge = '';
    if (filter === 'no-cd') {
      statusBadge = '<span class="badge badge-digital">Numérique</span>';
    } else if (hasNum) {
      statusBadge = '<span class="badge badge-flac" style="background:rgba(200,240,100,0.15);color:var(--accent)">✅ Sauvegardé</span>';
    } else {
      statusBadge = '<span class="badge badge-missing">⚠️ Sans backup</span>';
    }

    // Supports liés
    const numBadges = [];
    const fmt = a.format;
    if (a.cd || a.has_cd) numBadges.push('<span class="badge badge-cd">💿 CD</span>');
    if (fmt==='flac' || a.flac || (linked && (linked.format==='flac'||linked.flac))) numBadges.push('<span class="badge badge-flac">FLAC</span>');
    if (fmt==='mp3'  || a.mp3  || (linked && (linked.format==='mp3' ||linked.mp3)))  numBadges.push('<span class="badge badge-mp3">MP3</span>');
    if (fmt==='digital'||a.digital||(linked&&(linked.format==='digital'||linked.digital))) numBadges.push('<span class="badge badge-digital">Digital</span>');
    if (linked) numBadges.push(`<span class="badge" style="background:var(--purple-dim);color:var(--purple);border:1px solid rgba(176,140,255,0.2)">🔗 ${esc(linked.album)}</span>`);

    // Bouton associer — passer l'id (texte) entre guillemets
    const safeId = sid(aKey);
    const assocBtn = isCD
      ? `<button class="btn btn-sm" onclick="openAssocModal('${safeId}')" title="Associer à une entrée numérique">🔗 Associer</button>`
      : (isDigital && !linkedKeys.length)
        ? `<button class="btn btn-sm" onclick="openAssocModalReverse('${safeId}')" title="Associer à un CD Discogs">💿 Lier CD</button>`
        : '';
    const unlinkBtn = linkedKeys.length
      ? `<button class="btn btn-sm btn-danger" onclick="removeAssociation('${safeId}')" title="Supprimer l'association">✕</button>`
      : '';

  const noteCell = a.note ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${a.note.toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`;

    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    const hasManualRym = rymAssociations.some(x => x.albumKey === a.id);
    const rymCell = `<span onclick="event.stopPropagation();openRYMAssocFromCollection('${safeId}')" title="Associer/modifier la note RYM" style="cursor:pointer;display:inline-flex;align-items:center;gap:3px">
      ${rymEntry?.rating
        ? `<span style="font-family:var(--mono);font-size:12px;color:var(--amber)">${rymEntry.rating.toFixed(2)}<span style="font-size:10px;opacity:0.7">★</span></span>${hasManualRym ? '<span style="font-size:9px;color:var(--accent)">🔗</span>' : ''}`
        : `<span style="color:var(--text3);font-size:12px;opacity:0.35">⭐</span>`}
    </span>`;

    return `<tr onclick="editAlbum('${safeId}')" style="cursor:pointer">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-select" data-id="${safeId}" ${selectedAlbumIds.has(a.id) ? 'checked' : ''} onchange="toggleAlbumSelected('${safeId}', this.checked)"></td>
      <td>
        <div class="artist-cell">
          <div class="artist-avatar">${albumAvatar(a)}</div>
          <div class="artist-info">
            <div class="name">${esc(a.album)}${mbTypeBadge(a)}</div>
            <div class="sub">${artistLink(a.artist)}</div>
          </div>
        </div>
      </td>
      <td class="mono">${a.year || '–'}${origYearBadge(a)}</td>
      <td>${statusBadge}</td>
           <td><div class="badges-cell">${numBadges.join('') || '<span style="color:var(--text3);font-size:11px">–</span>'}</div></td>
      <td>${noteCell}</td>
      <td><span onclick="event.stopPropagation();promptDiscogsRating('${safeId}')" title="Modifier la note Discogs" style="cursor:pointer;display:inline-flex;align-items:center">
          ${a.discogsRating ? `<span style="font-family:var(--mono);font-size:12px;color:var(--blue)">${Number(a.discogsRating).toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>` : `<span style="color:var(--text3);font-size:11px">–</span>`}
        </span></td>
      <td>${rymCell}</td>
      <td>
        <div class="plays-bar-wrap">
          <div class="plays-bar"><div class="plays-fill" style="width:${Math.round((a.plays||0)/Math.max(1,...albums.map(x=>x.plays||0))*100)}%"></div></div>
          <span class="plays-num">${a.plays||0}</span>
        </div>
      </td>
      <td onclick="event.stopPropagation()" style="display:flex;gap:4px;align-items:center">
        ${assocBtn}${unlinkBtn}
        <button class="btn btn-sm" onclick="event.stopPropagation();markForSale('${safeId}')" title="${a.forSale?'Déjà à vendre':'Marquer à vendre'}" style="${a.forSale?'color:var(--amber)':''}">💸</button>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('disco-page-info').textContent = `Page ${discoPage} / ${pages} — ${total} entrées`;
  updateNavBadges();
  renderBulkActionsBar();
  const selAllDiscoCb = document.getElementById('select-all-disco');
  if (selAllDiscoCb) selAllDiscoCb.checked = slice.length > 0 && slice.every(a => selectedAlbumIds.has(a.id));
}

function prevDiscoPage() { if (discoPage > 1) { discoPage--; renderDiscographie(); } }
function nextDiscoPage() {
  const pages = Math.ceil(discoFilteredList().length / PAGE_SIZE);
  if (discoPage < pages) { discoPage++; renderDiscographie(); }
}

// ===================== ASSOCIATION =====================
// Les associations utilisent des clés texte stables (normalizeKey) au lieu d'IDs entiers
let _assocTargetKey = null; // cdKey texte

function openAssocModal(albumId) {
  const realId = unsid(albumId);
  const a = albums.find(x => x.id === realId);
  if (!a) return;
  _assocTargetKey = a.id;
  document.getElementById('assoc-cd-info').innerHTML =
    `<strong>CD :</strong> ${esc(a?.album)} — ${esc(a?.artist)} ${a?.year ? '(' + a.year + ')' : ''}`;
  const searchEl = document.getElementById('assoc-search');
  searchEl.value = '';
  searchEl.oninput = () => (_assocReverseNumKey ? renderAssocListReverse() : renderAssocList());
  _assocReverseNumKey = null;
  renderAssocList();
  document.getElementById('modal-assoc').classList.add('open');
  setTimeout(() => searchEl.focus(), 150);
}

function closeAssocModal() {
  document.getElementById('modal-assoc').classList.remove('open');
  _assocTargetKey = null;
}

function openAssocModalReverse(albumId) {
  const realId = unsid(albumId);
  const a = albums.find(x => x.id === realId);
  if (!a) return;
  const numKey = a.id;
  const cdCandidates = albums
    .filter(x => x.cd || x.has_cd)
    .filter(x => {
      const xAlbumNorm = normalizeKey('', x.album).replace('|||','');
      const aAlbumNorm = normalizeKey('', a.album).replace('|||','');
      if (xAlbumNorm !== aAlbumNorm) return false;
      for (const av of artistVariants(x.artist)) {
        if (artistVariants(a.artist).has(av)) return true;
      }
      return false;
    });

  if (cdCandidates.length === 1) {
    const cdAlbum = cdCandidates[0];
    if (confirm(`Associer "${a.artist} — ${a.album}" (numérique) au CD "${cdAlbum.artist} — ${cdAlbum.album}" ?`)) {
      associations.push({ cdKey: cdAlbum.id, numKey });
      invalidateCache(); saveToStorage(); renderDiscographie();
      toast(`Association créée : ${cdAlbum.artist} — ${cdAlbum.album}`);
    }
  } else {
    _assocTargetKey = null;
    _assocReverseNumKey = numKey;
    document.getElementById('assoc-cd-info').innerHTML =
      `<strong>Numérique :</strong> ${esc(a.album)} — ${esc(a.artist)} — chercher le CD correspondant`;
    const searchEl = document.getElementById('assoc-search');
    // Recherche vide par défaut : un titre traduit ("Everything's Calm" vs "Tout est calme")
    // ne matcherait jamais si on pré-remplissait avec le titre — on liste tout, trié par pertinence.
    searchEl.value = '';
    searchEl.oninput = () => (_assocReverseNumKey ? renderAssocListReverse() : renderAssocList());
    renderAssocListReverse();
    document.getElementById('modal-assoc').classList.add('open');
    setTimeout(() => searchEl.focus(), 150);
  }
}

let _assocReverseNumKey = null;

function renderAssocListReverse() {
  const q = document.getElementById('assoc-search').value.toLowerCase().trim();
  const numAlbum = albumByKey(_assocReverseNumKey);
  const numAlbumNorm = normalizeKey('', numAlbum?.album || '').replace('|||','');
  let candidates = albums
    .filter(a => a.cd || a.has_cd)
    .filter(a => {
      if (!q) return true;
      const terms = [
        a.artist, cleanDiscogsArtist(a.artist),
        (a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,''),
        a.album
      ].join(' ').toLowerCase();
      return terms.includes(q);
    });
  // Recherche sans résultat (ex: titre traduit dans une langue différente) → retomber sur
  // la liste complète plutôt que de laisser l'utilisateur bloqué sans aucun candidat.
  let fallback = false;
  if (q && !candidates.length) {
    candidates = albums.filter(a => a.cd || a.has_cd);
    fallback = true;
  }
  const el = document.getElementById('assoc-list');
  if (!candidates.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:12px">Aucun CD trouvé</div>';
    return;
  }
  const sorted = candidates.slice().sort((a, b) => {
      // Trier par similarité de titre album d'abord
      const aSim = normalizeKey('', a.album).replace('|||','') === numAlbumNorm ? 1 : 0;
      const bSim = normalizeKey('', b.album).replace('|||','') === numAlbumNorm ? 1 : 0;
      if (bSim !== aSim) return bSim - aSim;
      return cleanDiscogsArtist(a.artist).localeCompare(cleanDiscogsArtist(b.artist), 'fr');
    });
  const banner = fallback
    ? `<div style="font-size:11px;color:var(--text3);padding:4px 2px 8px">Aucun résultat pour « ${esc(q)} » — voici tous les CD disponibles, cherche par titre traduit ou fais défiler.</div>`
    : '';
  el.innerHTML = banner + sorted.map(a => {
    const similar = normalizeKey('', a.album).replace('|||','') === numAlbumNorm;
    return `<div style="background:${similar?'var(--accent-dim)':'var(--bg3)'};border:1px solid ${similar?'rgba(200,240,100,0.3)':'var(--border)'};border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer" onclick="applyAssociationReverse('${sid(a.id)}')">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${esc(a.album)}</div>
        <div style="font-size:11px;color:var(--text2)">${esc(a.artist)} ${a.year ? '· '+a.year : ''}</div>
      </div>
      <span class="badge badge-cd">CD</span>
    </div>`;
  }).join('');
}

function applyAssociationReverse(cdKey) {
  const numKey = _assocReverseNumKey;
  if (!numKey) return;
  const realCdKey = unsid(cdKey);
  associations.push({ cdKey: realCdKey, numKey });
  _assocReverseNumKey = null;
  document.getElementById('modal-assoc').classList.remove('open');
  invalidateCache(); saveToStorage(); renderDiscographie();
  const cdA = albumByKey(realCdKey);
  toast(`Association créée : ${cdA?.artist} — ${cdA?.album}`);
}

function renderAssocList() {
  const q = document.getElementById('assoc-search').value.toLowerCase().trim();
  const cdAlbum = albumByKey(_assocTargetKey);
  const usedNumKeys = new Set(associations.map(a => a.numKey));
  // Une même entrée numérique peut couvrir plusieurs CDs (ex: réédition regroupant deux
  // albums en une seule sortie digitale) — on ne l'exclut plus, on l'indique juste par badge.
  const candidates = albums
    .filter(a => (a.format || a.flac || a.mp3 || a.digital) && a.id !== _assocTargetKey)
    .filter(a => {
      if (!q) return true;
      const terms = [
        a.artist, cleanDiscogsArtist(a.artist),
        (a.artist||'').replace(/^The\s+/i,'').replace(/^A\s+/i,''),
        a.album
      ].join(' ').toLowerCase();
      return terms.includes(q);
    });
  const el = document.getElementById('assoc-list');
  if (!candidates.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:12px">Aucune entrée numérique trouvée</div>';
    return;
  }
  const cdAlbumNorm = normalizeKey('', cdAlbum?.album || '').replace('|||','');
  const cdArtistVariants = cdAlbum ? artistVariants(cdAlbum.artist) : new Set();
  // Score de similarité : titre identique normalisé + artiste reconnu via variantes → priorité maximale
  const scored = candidates.map(a => {
    const albumSimilar = normalizeKey('', a.album).replace('|||','') === cdAlbumNorm;
    let artistSimilar = false;
    for (const av of artistVariants(a.artist)) {
      if (cdArtistVariants.has(av)) { artistSimilar = true; break; }
    }
    const score = (albumSimilar ? 2 : 0) + (artistSimilar ? 1 : 0);
    return { a, score, similar: albumSimilar && artistSimilar };
  }).sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return cleanDiscogsArtist(x.a.artist).localeCompare(cleanDiscogsArtist(y.a.artist), 'fr');
  });
  el.innerHTML = scored.map(({ a, similar }) => {
    const numBadges = [
      (a.format==='flac'||a.flac) ? '<span class="badge badge-flac">FLAC</span>' : '',
      (a.format==='mp3'||a.mp3)   ? '<span class="badge badge-mp3">MP3</span>'   : '',
      (a.format==='digital'||a.digital) ? '<span class="badge badge-digital">Digital</span>' : '',
    ].filter(Boolean).join('');
    const alreadyLinked = usedNumKeys.has(a.id);
    return `<div style="background:${similar?'var(--accent-dim)':'var(--bg3)'};border:1px solid ${similar?'rgba(200,240,100,0.3)':'var(--border)'};border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer" onclick="applyAssociation('${sid(a.id)}')">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${esc(a.album)}</div>
        <div style="font-size:11px;color:var(--text2)">${esc(a.artist)}${a.year?' · '+a.year:''}</div>
      </div>
      <div style="display:flex;gap:4px">${numBadges}</div>
      ${similar?'<span style="font-size:10px;color:var(--accent);font-family:var(--mono)">≈ match</span>':''}
      ${alreadyLinked?'<span style="font-size:10px;color:var(--text3);font-family:var(--mono)" title="Déjà lié à un autre CD — peut être partagé">🔗 déjà lié</span>':''}
    </div>`;
  }).join('');
}

function applyAssociation(numKey) {
  if (!_assocTargetKey) return;
  const realNumKey = unsid(numKey);
  associations = associations.filter(a => a.cdKey !== _assocTargetKey);
  associations.push({ cdKey: _assocTargetKey, numKey: realNumKey });
  closeAssocModal();
  renderDiscographie();
  saveToStorage();
  toast('Association créée ✓');
}

function removeAssociation(albumId) {
  // albumId peut être cdKey ou numKey selon le contexte
  const realId = unsid(albumId);
  associations = associations.filter(a => a.cdKey !== realId && a.numKey !== realId);
  renderDiscographie();
  saveToStorage();
  toast('Association supprimée');
}

document.getElementById('modal-assoc').addEventListener('click', function(e) {
  if (e.target === this) closeAssocModal();
});


// ===================== RYM ASSOCIATIONS =====================
let _rymAssocTarget = null;
let _rymMissingCache  = [];
let _rymUnratedCache  = [];
let _rymOrphansCache  = [];
let _rymUnlinkedCache = [];

function openRYMAssocModalIdx(idx) {
  const r = _rymMissingCache[idx];
  if (!r) return;
  openRYMAssocModal(normalizeKey(r.artist, r.album), r.artist, r.album, r.rating);
}
function openRYMUnratedAssocIdx(idx) {
  const r = _rymUnratedCache[idx];
  if (!r) return;
  openRYMAssocModal(normalizeKey(r.artist, r.album), r.artist, r.album, r.rating || 0);
}
function openRYMOrphanAssocIdx(idx) {
  const r = _rymOrphansCache[idx];
  if (!r) return;
  openRYMAssocModal(normalizeKey(r.artist, r.album), r.artist, r.album, r.rating || 0);
}
function openRYMUnlinkedAssocIdx(idx) {
  const r = _rymUnlinkedCache[idx];
  if (!r) return;
  openRYMAssocModal(normalizeKey(r.artist, r.album), r.artist, r.album, r.rating || 0);
}
// addFromRYMOrphanIdx / addFromRYMIdx (ajout manuel depuis les écrans RYM) supprimées
// (v2026.07.10-03) — idem, plus aucun bouton n'y mène.

function openRYMAssocModal(rymKey, artist, album, rating) {
  _rymAssocTarget = rymKey;
  document.getElementById('rym-assoc-info').innerHTML =
    `<strong>RYM :</strong> ${esc(album)} — ${esc(artist)} <span style="color:var(--amber);margin-left:8px">${rating.toFixed(2)} ★</span>`;
  document.getElementById('rym-assoc-search').value = artist;
  renderRYMAssocList();
  document.getElementById('modal-rym-assoc').classList.add('open');
}

function closeRYMAssocModal() {
  document.getElementById('modal-rym-assoc').classList.remove('open');
  _rymAssocTarget = null;
  _rymAuditReturnAfterAssoc = false;
}

function renderRYMAssocList() {
  const q = document.getElementById('rym-assoc-search').value.toLowerCase();
  const candidates = albums
    .filter(a => (a.cd || a.flac || a.mp3 || a.digital))
    .filter(a => !q || (a.artist + ' ' + a.album).toLowerCase().includes(q))
    .sort((a, b) => a.artist.localeCompare(b.artist, 'fr'))
    .slice(0, 50);

  const el = document.getElementById('rym-assoc-list');
  if (!candidates.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:12px">Aucun album trouvé</div>';
    return;
  }

  // Score de similarité pour trier les suggestions
  const rymEntry = rymData.find(r => normalizeKey(r.artist, r.album) === _rymAssocTarget);
  const rymArtistNorm = rymEntry ? normalizeKey(rymEntry.artist, '').replace('|||','') : '';
  const rymAlbumNorm = rymEntry ? normalizeKey('', rymEntry.album).replace('|||','') : '';

  const scored = candidates.map(a => {
    const an = normalizeKey(a.artist, '').replace('|||','');
    const bn = normalizeKey('', a.album).replace('|||','');
    let score = 0;
    if (an === rymArtistNorm) score += 2;
    else if (an.includes(rymArtistNorm) || rymArtistNorm.includes(an)) score += 1;
    if (bn === rymAlbumNorm) score += 2;
    else if (bn.includes(rymAlbumNorm) || rymAlbumNorm.includes(bn)) score += 1;
    return { a, score };
  }).sort((x, y) => y.score - x.score);

  el.innerHTML = scored.map(({ a, score }) => {
    const badges = [
      a.cd ? '<span class="badge badge-cd" style="font-size:9px">CD</span>' : '',
      a.flac ? '<span class="badge badge-flac" style="font-size:9px">FLAC</span>' : '',
      a.mp3 ? '<span class="badge badge-mp3" style="font-size:9px">MP3</span>' : '',
    ].filter(Boolean).join('');
    const bg = score >= 3 ? 'var(--accent-dim)' : 'var(--bg3)';
    const matchLabel = score >= 3 ? '<span style="font-size:10px;color:var(--accent);font-family:var(--mono);margin-left:6px">≈ match</span>' : '';
    return `<div onclick="applyRYMAssociation('${sid(a.id)}')" style="background:${bg};border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${esc(a.album)}${matchLabel}</div>
        <div style="font-size:11px;color:var(--text2)">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
      </div>
      <div style="display:flex;gap:4px">${badges}</div>
      ${a.discogsId ? `<span style="font-family:var(--mono);font-size:10px;color:var(--text3)">#${a.discogsId}</span>` : ''}
    </div>`;
  }).join('');
}

function applyRYMAssociation(albumId) {
  if (!_rymAssocTarget) return;
  const realId = unsid(albumId);
  const album = albums.find(a => a.id === realId);
  const albumKey = album ? album.id : realId; // id est déjà la clé stable
  rymAssociations = rymAssociations.filter(a => a.rymKey !== _rymAssocTarget);
  rymAssociations.push({ rymKey: _rymAssocTarget, albumKey });
  invalidateCache();
  const shouldReturnToAudit = _rymAuditReturnAfterAssoc;
  closeRYMAssocModal();
  renderRYM();
  saveToStorage();
  toast('Association RYM créée ✓');
  if (shouldReturnToAudit) {
    openRYMOwnershipAuditModal();
  }
}

function removeRYMAssociation(rymKey) {
  rymAssociations = rymAssociations.filter(a => a.rymKey !== rymKey);
  invalidateCache();
  renderRYM();
  saveToStorage();
  toast('Association supprimée');
}

document.getElementById('modal-rym-assoc').addEventListener('click', function(e) {
  if (e.target === this) closeRYMAssocModal();
});


async function importRYM(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-rym');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const rows = parseCSV(text);
    let imported = 0;
    const parsed = [];
    rows.forEach(row => {
      // Colonnes export natif RYM :
      // "RYM Rating","First Name","Last Name","Title","Release_Date","Genres","Labels","Catalog#","Review"
      // Ou variante : "Rating","Artist","Album"
      const rating = parseFloat(
        row['rym rating'] || row['rating'] || row['note'] || '0'
      );
      if (!rating) return;

      // Nom artiste : soit colonne "Artist", soit "First Name" + "Last Name"
      let artist = row['artist'] || row['artist name'] || '';
      if (!artist) {
        const fn = (row['first name'] || '').trim();
        const ln = (row['last name'] || '').trim();
        artist = [fn, ln].filter(Boolean).join(' ');
      }

      const album = row['title'] || row['album'] || row['album title'] || '';
      if (!artist || !album) return;

      const year = (row['release_date'] || row['year'] || '').slice(0, 4);
      const genre = row['genres'] || row['genre'] || '';

      parsed.push({ artist: artist.trim(), album: album.trim(), rating, year, genre });
      imported++;
    });

    rymData = parsed;
    status.textContent = `✓ ${imported} ratings RYM chargés`;
    status.className = 'status ok';
    renderRYM();
    updateNavBadges();
    saveToStorage();
    toast(`RYM : ${imported} ratings importés`);
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}

function getRYMThreshold() {
  const sel = document.getElementById('rym-threshold');
  return sel ? parseFloat(sel.value) : 3.5;
}

// Index partagé de tout ce qui est "possédé" pour les rapprochements RYM.
// Couvre : albums[] (CD, num, okFolder, forSale) + stockItems[]
// Utilise artistVariants pour gérer feat./with/&/;/Various/casse/The
function getOwnedRymKeys() {
  if (_cache.ownedRymKeys) return _cache.ownedRymKeys;
  const keys = new Set();
  const mbIds = new Set();

  const indexEntry = (artist, album, mb_release_id) => {
    const albumNorm = normalizeKey('', album).replace('|||', '');
    for (const av of artistVariants(artist)) {
      keys.add(av + '|||' + albumNorm);
    }
    // Clé standard complète (sans passer par artistVariants, garde-fou)
    keys.add(normalizeKey(artist, album));
    if (mb_release_id) mbIds.add(mb_release_id);
  };

  // Tous les albums avec un support quelconque (y compris ok, à vendre)
  albums.forEach(a => {
    if (a.cd || a.flac || a.mp3 || a.digital || a.okFolder || a.forSale) {
      indexEntry(a.artist, a.album, a.mb_release_id);
    }
  });

  // Stock : possédés numériquement, juste pas encore dans la collection principale
  stockItems.forEach(s => indexEntry(s.artist, s.album, null));

  _cache.ownedRymKeys = { keys, mbIds };
  return _cache.ownedRymKeys;
}

// Albums notés >= seuil sur RYM mais absents de la collection (CD, numérique, stock, ok, à vendre)
function computeRYMMissing() {
  if (_cache.rymMissing) return _cache.rymMissing;
  if (!rymData.length) return (_cache.rymMissing = []);
  const threshold = getRYMThreshold();
  const { keys: ownedKeys, mbIds: ownedMbIds } = getOwnedRymKeys();
  const associatedRymKeys = new Set(rymAssociations.map(a => a.rymKey));
  _cache.rymMissing = rymData
    .filter(r => r.rating >= threshold)
    .filter(r => {
      const albumNorm = normalizeKey('', r.album).replace('|||', '');
      // Vérifier toutes les variantes artiste du côté RYM
      for (const av of artistVariants(r.artist)) {
        if (ownedKeys.has(av + '|||' + albumNorm)) return false;
      }
      if (associatedRymKeys.has(normalizeKey(r.artist, r.album))) return false;
      if (r.mb_release_id && ownedMbIds.has(r.mb_release_id)) return false;
      return true;
    })
    .sort((a, b) => b.rating - a.rating);
  return _cache.rymMissing;
}

// Entrées RYM sans note (rating absent ou 0) — uniquement celles qui sont possédées
// (inutile d'afficher des non-notés pour des albums qu'on n'a pas)
function computeRYMUnrated() {
  if (_cache.rymUnrated) return _cache.rymUnrated;
  if (!rymData.length) return (_cache.rymUnrated = []);
  const { keys: ownedKeys } = getOwnedRymKeys();
  const associatedRymKeys = new Set(rymAssociations.map(a => a.rymKey));
  _cache.rymUnrated = rymData
    .filter(r => !r.rating || r.rating === 0)
    .filter(r => {
      const rymKey = normalizeKey(r.artist, r.album);
      // Associé manuellement → toujours inclure
      if (associatedRymKeys.has(rymKey)) return true;
      // Ownership renseigné → inclure même si non matchable automatiquement
      if ((r.ownership || '').trim()) return true;
      // Possédé via matching automatique
      const albumNorm = normalizeKey('', r.album).replace('|||', '');
      for (const av of artistVariants(r.artist)) {
        if (ownedKeys.has(av + '|||' + albumNorm)) return true;
      }
      return false;
    })
    .sort((a, b) => (a.artist + a.album).localeCompare(b.artist + b.album, 'fr'));
  return _cache.rymUnrated;
}

// Entrées RYM avec ownership renseigné mais introuvables dans la collection complète
// (albums[], stockItems[], okFolder, forSale — avec toutes variantes artiste)
function computeRYMOrphans() {
  if (_cache.rymOrphans) return _cache.rymOrphans;
  if (!rymData.length) return (_cache.rymOrphans = []);
  const { keys: ownedKeys } = getOwnedRymKeys();
  const associatedRymKeys = new Set(rymAssociations.map(a => a.rymKey));
  _cache.rymOrphans = rymData
    .filter(r => {
      const own = (r.ownership || '').trim().toLowerCase();
      if (!own) return false; // pas d'ownership → on n'inclut pas
      const key = normalizeKey(r.artist, r.album);
      if (associatedRymKeys.has(key)) return false;
      const albumNorm = normalizeKey('', r.album).replace('|||', '');
      for (const av of artistVariants(r.artist)) {
        if (ownedKeys.has(av + '|||' + albumNorm)) return false;
      }
      return true;
    })
    .sort((a, b) => (a.artist + a.album).localeCompare(b.artist + b.album, 'fr'));
  return _cache.rymOrphans;
}

// Entrées RYM notées ET possédées mais sans association manuelle dans rymAssociations
// Ces albums sont matchés automatiquement (ou via ownership) mais jamais confirmés manuellement —
// utile pour repérer les faux positifs du matching automatique.
function computeRYMUnlinked() {
  if (_cache.rymUnlinked) return _cache.rymUnlinked;
  if (!rymData.length) return (_cache.rymUnlinked = []);
  const { keys: ownedKeys } = getOwnedRymKeys();
  const associatedRymKeys = new Set(rymAssociations.map(a => a.rymKey));
  _cache.rymUnlinked = rymData
    .filter(r => {
      if (!r.rating) return false;
      const rymKey = normalizeKey(r.artist, r.album);
      // Déjà associé manuellement → ne pas afficher
      if (associatedRymKeys.has(rymKey)) return false;
      // Vérifier si possédé (auto-match via ownedKeys ou ownership renseigné)
      const albumNorm = normalizeKey('', r.album).replace('|||', '');
      const ownedByKey = Array.from(artistVariants(r.artist))
        .some(av => ownedKeys.has(av + '|||' + albumNorm));
      const hasOwnership = !!(r.ownership || '').trim();
      return ownedByKey || hasOwnership;
    })
    .sort((a, b) => b.rating - a.rating || a.artist.localeCompare(b.artist, 'fr'));
  return _cache.rymUnlinked;
}

// Index inverse de getOwnedRymKeys : mêmes clés, mais on garde aussi la fiche
// source (album ou stock) pour pouvoir l'afficher dans l'audit ownership.
function getOwnedRymIndex() {
  if (_cache.ownedRymIndex) return _cache.ownedRymIndex;
  const idx = new Map();
  const indexEntry = (type, item, artist, album) => {
    const albumNorm = normalizeKey('', album).replace('|||', '');
    for (const av of artistVariants(artist)) {
      const key = av + '|||' + albumNorm;
      if (!idx.has(key)) idx.set(key, { type, item });
    }
  };
  albums.forEach(a => {
    if (a.cd || a.flac || a.mp3 || a.digital || a.okFolder || a.forSale) indexEntry('album', a, a.artist, a.album);
  });
  stockItems.forEach(s => indexEntry('stock', s, s.artist, s.album));
  _cache.ownedRymIndex = idx;
  return idx;
}

// Retrouve la fiche réelle (album ou stock) qui a fait matcher automatiquement
// une entrée RYM comme "possédée", pour pouvoir vérifier la correspondance à l'œil
// plutôt que de se fier au simple booléen ownedKeys.has(...).
function findOwnedMatchForRym(r) {
  const idx = getOwnedRymIndex();
  const albumNorm = normalizeKey('', r.album).replace('|||', '');
  for (const av of artistVariants(r.artist)) {
    const hit = idx.get(av + '|||' + albumNorm);
    if (hit) return hit;
  }
  return null;
}

// Audit complet : chaque entrée RYM avec ownership renseigné, avec le détail de
// à quelle fiche de la collection elle est rattachée (manuelle, auto, ou aucune).
function computeRYMOwnershipAudit() {
  const associatedByKey = new Map(rymAssociations.map(a => [a.rymKey, a]));
  return rymData
    .filter(r => (r.ownership || '').trim())
    .map(r => {
      const rymKey = normalizeKey(r.artist, r.album);
      const assoc = associatedByKey.get(rymKey);
      const assocAlbum = assoc ? albums.find(a => a.id === assoc.albumKey) : null;
      const auto = (!assocAlbum) ? findOwnedMatchForRym(r) : null;
      return { r, assocAlbum, auto };
    })
    .sort((a, b) => (a.r.artist + a.r.album).localeCompare(b.r.artist + b.r.album, 'fr'));
}

function openRYMOwnershipAuditModal() {
  renderRYMOwnershipAuditList();
  document.getElementById('modal-rym-ownership-audit').classList.add('open');
}

function closeRYMOwnershipAuditModal() {
  document.getElementById('modal-rym-ownership-audit').classList.remove('open');
}

let _rymOwnershipAuditCache = [];
let _rymAuditReturnAfterAssoc = false;

function renderRYMOwnershipAuditList() {
  const allRows = computeRYMOwnershipAudit();
  const nMatched = allRows.filter(x => x.assocAlbum || x.auto).length;
  const nNone = allRows.length - nMatched;
  document.getElementById('rym-ownership-audit-counter').textContent =
    `${allRows.length} entrée${allRows.length > 1 ? 's' : ''} avec ownership · ${nMatched} rattachée${nMatched > 1 ? 's' : ''} · ${nNone} sans correspondance`;

  const showAll = document.getElementById('rym-ownership-audit-showall').checked;
  const rows = showAll ? allRows : allRows.filter(x => !x.assocAlbum && !x.auto);
  _rymOwnershipAuditCache = rows;

  const el = document.getElementById('rym-ownership-audit-list');
  if (!rows.length) {
    el.innerHTML = showAll
      ? '<div class="empty" style="padding:24px"><div class="empty-icon">⭐</div>Aucune entrée RYM avec ownership renseigné.</div>'
      : '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Toutes les entrées avec ownership sont rattachées !</div>';
    return;
  }

  el.innerHTML = rows.map(({ r, assocAlbum, auto }, idx) => {
    let statusHtml;
    let actionsHtml = '';
    if (assocAlbum) {
      statusHtml = `<span style="color:var(--accent);font-size:12px">🔗 Lié manuellement à : <strong>${esc(assocAlbum.artist)} — ${esc(assocAlbum.album)}</strong></span>`;
    } else if (auto) {
      const label = auto.type === 'stock' ? ' (stock)' : '';
      statusHtml = `<span style="color:var(--green,#4caf50);font-size:12px">✓ Correspondance auto : <strong>${esc(auto.item.artist)} — ${esc(auto.item.album)}</strong>${label}</span>`;
    } else {
      statusHtml = `<span style="color:var(--warn,#e0a030);font-size:12px">❌ Aucune correspondance trouvée dans la collection ou le stock</span>`;
      actionsHtml = `
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-sm" onclick="openRYMOwnershipAuditAssocIdx(${idx})" title="Associer à un album de la collection">🔗 Associer</button>
        </div>`;
    }
    const own = `<span class="badge badge-cd" style="font-size:10px">${esc(r.ownership)}</span>`;
    return `
      <div class="missing-card" style="flex-direction:column;align-items:flex-start;gap:4px;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:8px;width:100%">
          <div style="flex:1">
            <div class="missing-info" style="margin:0">
              <div class="title" style="font-size:13px">${esc(r.album)}</div>
              <div class="sub" style="font-size:11px">${esc(r.artist)}${r.year ? ' · ' + r.year : ''} ${own}</div>
            </div>
          </div>
          ${r.rating ? rymStars(r.rating) : '<span style="color:var(--text3);font-size:11px">Non noté</span>'}
        </div>
        <div>${statusHtml}</div>
        ${actionsHtml}
      </div>`;
  }).join('');
}

function openRYMOwnershipAuditAssocIdx(idx) {
  const row = _rymOwnershipAuditCache[idx];
  if (!row) return;
  const { r } = row;
  _rymAuditReturnAfterAssoc = true;
  closeRYMOwnershipAuditModal();
  openRYMAssocModal(normalizeKey(r.artist, r.album), r.artist, r.album, r.rating || 0);
}

// addFromRYMOwnershipAuditIdx (ajout manuel depuis l'audit RYM) supprimée (v2026.07.10-03).

function rymStars(rating) {
  // RYM note sur 5 avec demi-étoiles
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.25 && rating % 1 < 0.75;
  let s = '';
  for (let i = 1; i <= 5; i++) {
    if (i <= full) s += '<span style="color:var(--amber)">★</span>';
    else if (i === full + 1 && half) s += '<span style="color:var(--amber);opacity:0.5">★</span>';
    else s += '<span style="color:var(--border2)">★</span>';
  }
  return `<span style="font-size:13px">${s}</span> <span style="font-family:var(--mono);font-size:11px;color:var(--text2)">${rating.toFixed(2)}</span>`;
}

function rymGenreList() {
  const set = new Set();
  rymData.forEach(r => { if (r.genre) set.add(r.genre); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function updateRymGenreFilter() {
  const sel = document.getElementById('filter-rym-genre');
  if (!sel) return;
  const cur = sel.value;
  const genres = rymGenreList();
  sel.innerHTML = '<option value="">Tous genres</option>' + genres.map(g => `<option value="${esc(g)}" ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

function resetRymFilters() {
  ['filter-rym-artist', 'filter-rym-album', 'filter-rym-year'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const genreSel = document.getElementById('filter-rym-genre');
  if (genreSel) genreSel.value = '';
  renderRYM();
}

// Filtres locaux à l'onglet RYM (Artiste/Album/Genre/Année) — s'ajoutent à la recherche globale
// (#global-search, déjà appliquée plus bas) et au seuil de note (rym-threshold, qui ne
// s'applique qu'à la liste "Notés — absents"). Appliqués aux 4 listes de l'écran.
function rymFilterMatch(r) {
  const fArtist = (document.getElementById('filter-rym-artist')?.value || '').toLowerCase().trim();
  const fAlbum  = (document.getElementById('filter-rym-album')?.value  || '').toLowerCase().trim();
  const fGenre  = document.getElementById('filter-rym-genre')?.value || '';
  const fYear   = (document.getElementById('filter-rym-year')?.value  || '').trim();
  if (fArtist && !r.artist.toLowerCase().includes(fArtist)) return false;
  if (fAlbum  && !r.album.toLowerCase().includes(fAlbum)) return false;
  if (fGenre  && r.genre !== fGenre) return false;
  if (fYear   && !(r.year || '').startsWith(fYear)) return false;
  return true;
}

function renderRYM() {
  updateRymGenreFilter();
  if (!rymData.length) {
    document.getElementById('rym-missing-list').innerHTML =
      '<div class="empty"><div class="empty-icon">⭐</div>Chargez votre fichier ratings.csv RYM ci-dessus.</div>';
    document.getElementById('rym-unrated-list').innerHTML = '';
    document.getElementById('rym-missing-count').textContent = '0';
    document.getElementById('rym-unrated-count').textContent = '0';
    return;
  }

  const q = document.getElementById('global-search').value.toLowerCase();

  // --- Notés sur RYM mais absents de la collection ---
  let missing = computeRYMMissing();
  if (q) missing = missing.filter(r => (r.artist + ' ' + r.album).toLowerCase().includes(q));
  missing = missing.filter(rymFilterMatch);
  document.getElementById('rym-missing-count').textContent = missing.length;
  const missingEl = document.getElementById('rym-missing-list');
  if (!missing.length) {
    missingEl.innerHTML = '<div class="empty" style="padding:20px"><div class="empty-icon">✅</div>Aucun manquant au-dessus du seuil !</div>';
  } else {
    _rymMissingCache = missing;
    missingEl.innerHTML = missing.map(r => {
      const rymKey = normalizeKey(r.artist, r.album);
      const assoc = rymAssociations.find(a => a.rymKey === rymKey);
      const assocAlbum = assoc ? albums.find(a => a.id === assoc.albumKey) : null;
      const inWishlist = wishlist.some(w => normalizeKey(w.artist, w.album) === rymKey);
      const wishBtn = inWishlist
        ? `<span class="btn btn-sm" style="opacity:0.7;cursor:default;color:var(--accent);border-color:var(--accent)" title="Déjà dans la wishlist">🎯 Wishlist</span>`
        : `<button class="btn btn-sm" onclick="addToWishlistFromRYMIdx(${missing.indexOf(r)})" title="Ajouter à la wishlist">🎯</button>`;
      return `
      <div class="missing-card" style="flex-direction:column;align-items:flex-start;gap:6px">
        <div style="display:flex;align-items:center;gap:10px;width:100%">
          <div style="flex:1">
            <div class="missing-info" style="margin:0">
              <div class="title">${esc(r.album)}</div>
              <div class="sub">${esc(r.artist)}${r.year ? ' · ' + r.year : ''}</div>
            </div>
          </div>
          ${rymStars(r.rating)}
          <button class="btn btn-sm" onclick="openRYMAssocModalIdx(${missing.indexOf(r)})" title="Associer à un album de la collection">🔗 Associer</button>
          ${wishBtn}
        </div>
        ${r.genre ? `<div style="font-size:11px;color:var(--text3)">${esc(r.genre)}</div>` : ''}
      </div>`;
    }).join('');
  }

  // --- Non notés sur RYM ---
  let unrated = computeRYMUnrated();
  if (q) unrated = unrated.filter(r => (r.artist + ' ' + r.album).toLowerCase().includes(q));
  unrated = unrated.filter(rymFilterMatch);
  document.getElementById('rym-unrated-count').textContent = unrated.length;
  const unratedEl = document.getElementById('rym-unrated-list');
  if (!unrated.length) {
    unratedEl.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-icon">✅</div>Aucune entrée non notée !</div>';
  } else {
    unratedEl.innerHTML = unrated.map(r => {
      const rymKey = normalizeKey(r.artist, r.album);
      const own = r.ownership ? `<span class="badge badge-cd" style="font-size:10px">${esc(r.ownership)}</span>` : '';
      return `
        <div class="missing-card" style="padding:10px 14px;gap:10px">
          <div class="missing-info" style="min-width:0;flex:1">
            <div class="title" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.album)}</div>
            <div class="sub" style="font-size:11px">${esc(r.artist)}${r.year ? ' · ' + r.year : ''} ${own}</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            <button class="btn btn-sm" onclick="openRYMUnratedAssocIdx(${unrated.indexOf(r)})" title="Associer à un album de la collection">🔗 Associer</button>
          </div>
        </div>`;
    }).join('');
  }

  _rymUnratedCache = unrated;

  // --- Ownership renseigné mais introuvable ---
  let orphans = computeRYMOrphans();
  if (q) orphans = orphans.filter(r => (r.artist + ' ' + r.album).toLowerCase().includes(q));
  orphans = orphans.filter(rymFilterMatch);
  document.getElementById('rym-orphan-count').textContent = orphans.length;
  const orphanEl = document.getElementById('rym-orphan-list');
  if (!orphanEl) { updateNavBadges(); return; }
  if (!orphans.length) {
    orphanEl.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-icon">✅</div>Aucun orphelin !</div>';
  } else {
    _rymOrphansCache = orphans;
  orphanEl.innerHTML = orphans.map(r => {
      const rymKey = normalizeKey(r.artist, r.album);
      const own = r.ownership ? `<span class="badge badge-cd" style="font-size:10px">${esc(r.ownership)}</span>` : '';
      const ratingHtml = r.rating ? rymStars(r.rating) : '<span style="color:var(--text3);font-size:11px">Non noté</span>';
      return `
        <div class="missing-card" style="padding:10px 14px;gap:10px">
          <div class="missing-info" style="min-width:0;flex:1">
            <div class="title" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.album)}</div>
            <div class="sub" style="font-size:11px">${esc(r.artist)}${r.year ? ' · ' + r.year : ''} ${own}</div>
            <div style="margin-top:4px">${ratingHtml}</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            <button class="btn btn-sm" onclick="openRYMOrphanAssocIdx(${orphans.indexOf(r)})" title="Associer à un album de la collection">🔗 Associer</button>
          </div>
        </div>`;
    }).join('');
  }

  // --- Notés et possédés mais non associés manuellement ---
  let unlinked = computeRYMUnlinked();
  if (q) unlinked = unlinked.filter(r => (r.artist + ' ' + r.album).toLowerCase().includes(q));
  unlinked = unlinked.filter(rymFilterMatch);
  const unlinkedBadge = document.getElementById('rym-unlinked-count');
  if (unlinkedBadge) unlinkedBadge.textContent = unlinked.length;
  const unlinkedEl = document.getElementById('rym-unlinked-list');
  if (unlinkedEl) {
    if (!unlinked.length) {
      unlinkedEl.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-icon">✅</div>Tous les albums possédés sont associés manuellement !</div>';
    } else {
      _rymUnlinkedCache = unlinked;
      unlinkedEl.innerHTML = unlinked.map((r, i) => {
        const own = r.ownership ? `<span class="badge badge-cd" style="font-size:10px">${esc(r.ownership)}</span>` : '';
        // Chercher l'album matché automatiquement pour l'afficher
        const albumNorm = normalizeKey('', r.album).replace('|||', '');
        let autoMatch = null;
        for (const av of artistVariants(r.artist)) {
          autoMatch = albums.find(a => {
            const aNorm = normalizeKey('', a.album).replace('|||', '');
            return aNorm === albumNorm && artistVariants(a.artist).has(av);
          });
          if (autoMatch) break;
        }
        const matchHtml = autoMatch
          ? `<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">→ match auto : ${esc(autoMatch.artist)} — ${esc(autoMatch.album)}</span>`
          : r.ownership ? `<span style="font-size:10px;color:var(--text3)">ownership : ${esc(r.ownership)}</span>` : '';
        return `
          <div class="missing-card" style="padding:10px 14px;gap:10px">
            <div class="missing-info" style="min-width:0;flex:1">
              <div class="title" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.album)}</div>
              <div class="sub" style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <span>${esc(r.artist)}${r.year ? ' · ' + r.year : ''}</span>
                ${own}
              </div>
              <div style="margin-top:3px;display:flex;align-items:center;gap:8px">
                ${rymStars(r.rating)}
                ${matchHtml}
              </div>
            </div>
            <div style="display:flex;gap:5px;flex-shrink:0">
              <button class="btn btn-sm btn-accent" onclick="openRYMUnlinkedAssocIdx(${i})" title="Créer une association manuelle">🔗 Associer</button>
            </div>
          </div>`;
      }).join('');
    }
  }

  updateNavBadges();
}

// addFromRYM (ouvrait la modale d'ajout manuel) supprimée (v2026.07.10-03) — dernière
// des fonctions "ajout manuel d'album", retirée avec tous ses appelants ci-dessus.

// ===================== RYM HTML IMPORT =====================
async function importRYMHtml(input) {
  const files = Array.from(input.files);
  if (!files.length) return;

  const status = document.getElementById('status-rym-scrape');
  status.textContent = `Lecture de ${files.length} fichier(s)…`;
  status.className = 'status';

  let totalParsed = 0, totalNew = 0, totalUpdated = 0;

  for (const file of files) {
    try {
      const text = await readFile(file);
      const doc = new DOMParser().parseFromString(text, 'text/html');

      // Structure RYM : <tr id="page_catalog_item_XXXXXXX">
      //   <td class="or_q_artist"><a class="artist">Nom artiste <span class="subtext">[alias]</span></a></td>
      //   <td class="or_q_album"><a class="album">Titre album</a></td>
      //   <td class="or_q_rating">3.5</td>
      //   <td class="or_q_ownership">CD</td>  ← optionnel
      // </tr>

      const rows = doc.querySelectorAll('tr[id^="page_catalog_item_"]');

      rows.forEach(row => {
        // Artiste — enlever le subtext [alias]
        const artistEl = row.querySelector('.or_q_artist .artist');
        if (!artistEl) return;
        // Cloner pour enlever le span subtext avant de lire le texte
        const artistClone = artistEl.cloneNode(true);
        artistClone.querySelectorAll('.subtext').forEach(s => s.remove());
        const artist = artistClone.textContent.trim();

        // Album
        const albumEl = row.querySelector('.or_q_album .album');
        if (!albumEl) return;
        const album = albumEl.textContent.trim();

        if (!artist || !album) return;

        // Note — peut être vide (&nbsp;) si non noté
        const ratingEl = row.querySelector('.or_q_rating');
        const ratingText = ratingEl ? ratingEl.textContent.trim() : '';
        const rating = parseFloat(ratingText) || 0;

        // Ownership (CD, Wishlist, etc.)
        const ownershipEl = row.querySelector('.or_q_ownership');
        const ownership = ownershipEl ? ownershipEl.textContent.trim() : '';

        // N'importer que les entrées notées (rating > 0)
        if (!rating) return;

        totalParsed++;
        const key = normalizeKey(artist, album);
        const existing = rymData.find(x => normalizeKey(x.artist, x.album) === key);
        if (existing) {
          existing.rating = rating;
          existing.ownership = ownership;
          totalUpdated++;
        } else {
          rymData.push({ artist, album, rating, year: '', genre: '', ownership });
          totalNew++;
        }
      });

      status.textContent = `Fichier "${file.name}" : ${rows.length} lignes lues…`;
    } catch(e) {
      status.textContent = `Erreur sur "${file.name}" : ${e.message}`;
      status.className = 'status err';
    }
  }

  invalidateCache();

  if (totalParsed === 0) {
    status.textContent = '⚠️ Aucun rating trouvé. Vérifiez que vous avez sauvegardé la bonne page RYM.';
    status.className = 'status err';
  } else {
    status.textContent = `✓ ${totalParsed} ratings importés — ${totalNew} nouveaux, ${totalUpdated} mis à jour`;
    status.className = 'status ok';
    renderRYM();
    updateNavBadges();
    saveToStorage();
    toast(`RYM : ${totalParsed} ratings importés`);
  }

  input.value = '';
}

// Déduplication manuelle déclenchée par le bouton — avec rapport et sync Supabase
async function runDeduplication() {
  const before = albums.length;
  deduplicateAlbums();
  const removed = before - albums.length;
  invalidateCache();
  if (removed > 0) {
    await saveToSupabase();
    renderAlbums();
    updateNavBadges();
    toast(`🔧 ${removed} doublon${removed > 1 ? 's' : ''} fusionné${removed > 1 ? 's' : ''} et synchronisé${removed > 1 ? 's' : ''}`);
  } else {
    toast('Aucun doublon détecté');
  }
  const status = document.getElementById('status-json-reimport');
  if (status) {
    status.textContent = removed > 0
      ? `✓ ${removed} doublon${removed > 1 ? 's' : ''} supprimé${removed > 1 ? 's' : ''} — ${albums.length} albums restants`
      : `✓ Aucun doublon — ${albums.length} albums`;
    status.className = 'status ok';
  }
}
async function reimportCSV(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-reimport');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const rows = parseCSV(text);
      let added = 0, updated = 0;
    rows.forEach(row => {
      const artist = row['artist'] || '';
      const album = row['album'] || '';
      if (!artist || !album) return;
      const id = parseInt(row['id']) || null;
      const data = {
        artist, album,
        year: row['year'] || '',
        genre: row['genre'] || '',
        cd: row['cd'] === 'true' || row['cd'] === '1',
        flac: row['flac'] === 'true' || row['flac'] === '1',
        mp3: row['mp3'] === 'true' || row['mp3'] === '1',
        digital: row['digital'] === 'true' || row['digital'] === '1',
        note: parseInt(row['note']) || 0,
        plays: parseInt(row['plays']) || 0,
        notes: row['notes'] || '',
      };
      const existing = id ? albums.find(a => a.id === id) : albums.find(a => normalizeKey(a.artist, a.album) === normalizeKey(artist, album));
      if (existing) {
        Object.assign(existing, data);
        updated++;
      } else {
        albums.push({ id: id || uid(), ...data });
        added++;
      }
    });
    status.textContent = `✓ ${added} ajoutés, ${updated} mis à jour`;
    status.className = 'status ok';
    renderAlbums();
    toast(`Réimport : ${added} ajoutés, ${updated} mis à jour`);
    saveToStorage();
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}

// ===================== EXPORT =====================
function exportCSV() {
  const header = ['id','artist','album','year','genre','cd','flac','mp3','digital','note','plays','notes'];
  const rows = [header.join(','), ...albums.map(a => toCSVRow([
    a.id, a.artist, a.album, a.year||'', a.genre||'',
    a.cd?'true':'false', a.flac?'true':'false', a.mp3?'true':'false', a.digital?'true':'false',
    a.note||0, a.plays||0, a.notes||''
  ]))];
  download('discothèque_albums.csv', rows.join('\n'), 'text/csv');
  toast('Export CSV téléchargé ✓');
}

function exportTracksCSV() {
  const header = ['id','title','artist','album','format','duration','note'];
  const rows = [header.join(','), ...tracks.map(t => toCSVRow([t.id, t.title, t.artist, t.album||'', t.format, t.duration||'', t.note||0]))];
  download('discothèque_morceaux.csv', rows.join('\n'), 'text/csv');
  toast('Export morceaux téléchargé ✓');
}

// ── Exports filtrés par section ──────────────────────────────────────────────

function _csvDownload(filename, rows) {
  const bom = '\uFEFF';
  download(filename, bom + rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n'), 'text/csv;charset=utf-8');
}

// Notés sur RYM — absents de la collection (colonne de gauche de l'écran RYM)
function exportRYMMissingXLS() {
  const list = (_rymMissingCache && _rymMissingCache.length) ? _rymMissingCache : computeRYMMissing();
  const rows = [['Artiste', 'Album', 'Année', 'Note RYM', 'Genre']];
  list.forEach(r => rows.push([r.artist, r.album, r.year || '', r.rating || '', r.genre || '']));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 28 }, { wch: 36 }, { wch: 8 }, { wch: 10 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'RYM manquants');
  XLSX.writeFile(wb, `rym_manquants_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast(`${list.length} albums exportés ✓`);
}

function _rymRating(artist, album) {
  const r = lookupRym(artist, album) || lookupRym(cleanDiscogsArtist(artist), album);
  return r?.rating || '';
}

// Collection (tient compte de tous les filtres actifs)
function exportFilteredAlbumsCSV() {
  const lfExact = getLfExactMap();
  const list = sortedAlbums(filteredAlbums());
  const rows = [['Artiste','Album','Année','Genre','CD','FLAC','MP3','Digital','Note MB','Note RYM','Écoutes','Notes','Discogs ID']];
  list.forEach(a => rows.push([
    a.artist, a.album, a.year||'', a.genre||'',
    a.cd?'oui':'', a.flac?'oui':'', a.mp3?'oui':'', a.digital?'oui':'',
    a.note||'', _rymRating(a.artist, a.album),
    a.plays||0, a.notes||'', a.discogsId||''
  ]));
  _csvDownload(`albums_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} albums exportés ✓`);
}

// Discographie (filtre actif)
function exportDiscoCSV() {
  const list = discoFilteredList();
  const rows = [['Artiste','Album','Année','CD','FLAC','MP3','Digital','Backup num.','Note MB','Discogs ID']];
  list.forEach(a => rows.push([
    a.artist, a.album, a.year||'',
    a.cd?'oui':'', a.flac?'oui':'', a.mp3?'oui':'', a.digital?'oui':'',
    hasDigitalBackup(a)?'oui':'non',
    a.note||'', a.discogsId||''
  ]));
  _csvDownload(`discographie_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} entrées exportées ✓`);
}

// Ok albums (filtre artiste actif)
function exportOkAlbumsCSV() {
  const q  = (document.getElementById('global-search').value||'').toLowerCase();
  const af = (document.getElementById('filter-ok-artist')?.value||'').toLowerCase().trim();
  const list = albums.filter(a => a.okFolder)
    .filter(a => (!q||(a.artist+' '+a.album).toLowerCase().includes(q)) && (!af||a.artist.toLowerCase().includes(af)))
    .sort((a,b)=>a.artist.localeCompare(b.artist,'fr'));
  const rows = [['Artiste','Album','Année','Supports','Note MB','Écoutes']];
  list.forEach(a => {
    const sup = [a.cd?'CD':'',a.flac?'FLAC':'',a.mp3?'MP3':'',a.digital?'Digital':''].filter(Boolean).join('+');
    rows.push([a.artist, a.album, a.year||'', sup, a.note||'', a.plays||0]);
  });
  _csvDownload(`ok_albums_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} albums exportés ✓`);
}

// À vendre (filtre artiste actif)
function exportForSaleCSV() {
  const q  = (document.getElementById('global-search').value||'').toLowerCase();
  const af = (document.getElementById('filter-forsale-artist')?.value||'').toLowerCase().trim();
  const list = albums.filter(a => a.forSale)
    .filter(a => (!q||(a.artist+' '+a.album).toLowerCase().includes(q)) && (!af||a.artist.toLowerCase().includes(af)))
    .sort((a,b)=>a.artist.localeCompare(b.artist,'fr'));
  const rows = [['Artiste','Album','Année','Supports','Note MB','Discogs ID']];
  list.forEach(a => {
    const sup = [a.cd?'CD':'',a.flac?'FLAC':'',a.mp3?'MP3':'',a.digital?'Digital':''].filter(Boolean).join('+');
    rows.push([a.artist, a.album, a.year||'', sup, a.note||'', a.discogsId||'']);
  });
  _csvDownload(`a_vendre_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} albums exportés ✓`);
}

// last.fm albums manquants (filtres actifs — utilise _missingListCache)
function exportMissingAlbumsCSV() {
  const list = _missingListCache || computeMissing();
  const statusLabel = { ignored:'Ignoré', to_listen:'À écouter', wishlist:'Wishlist' };
  const rows = [['Artiste','Album','Écoutes','Statut','Note RYM','Genre']];
  list.forEach(m => {
    const st = getLastfmStatus(m.artist, m.album);
    const rymECsv = lookupRym(m.artist, m.album);
    rows.push([m.artist, m.album, m.plays, statusLabel[st]||'', _rymRating(m.artist, m.album), rymECsv?.genre || '']);
  });
  _csvDownload(`lastfm_albums_manquants_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} albums exportés ✓`);
}

// Morceaux isolés (filtres actifs)
function exportFilteredTracksCSV() {
  const lfExact = getLfExactMap();
  const q      = (document.getElementById('global-search').value||'').toLowerCase();
  const af     = (document.getElementById('filter-track-artist')?.value||'').toLowerCase().trim();
  const tf     = (document.getElementById('filter-track-title')?.value||'').toLowerCase().trim();
  const albf   = (document.getElementById('filter-track-album')?.value||'').toLowerCase().trim();
  const ff     = document.getElementById('filter-track-format')?.value||'';
  const nf     = document.getElementById('filter-track-note')?.value||'';
  const lf     = document.getElementById('filter-track-lastfm')?.value||'';
  const minPlf = parseInt(document.getElementById('filter-track-min-plays')?.value||'0')||0;
  const sortF  = document.getElementById('filter-track-sort')?.value||'artist';

  let list = tracks.filter(t => {
    const m   = !q    || (t.title+' '+t.artist+' '+(t.album||'')).toLowerCase().includes(q);
    const am  = !af   || t.artist.toLowerCase().includes(af);
    const tm  = !tf   || t.title.toLowerCase().includes(tf);
    const alm = !albf || (t.album||'').toLowerCase().includes(albf);
    const fm  = !ff   || t.format===ff;
    let nm = true;
    if (nf==='5') nm=t.note===5; else if(nf==='4') nm=t.note>=4; else if(nf==='3') nm=t.note>=3; else if(nf==='0') nm=!t.note;
    const plays = lfExact.get(normalizeKey(t.artist,t.title))||0;
    const isLoved = _lovedTracks.has(normalizeKey(t.artist,t.title));
    let lfm = true;
    if (lf==='present') lfm=plays>0; else if(lf==='absent') lfm=!plays; else if(lf==='loved') lfm=isLoved;
    return m&&am&&tm&&alm&&fm&&nm&&lfm&&plays>=minPlf;
  });
  if (sortF==='plays') list.sort((a,b)=>(lfExact.get(normalizeKey(b.artist,b.title))||0)-(lfExact.get(normalizeKey(a.artist,a.title))||0));
  else if (sortF==='title') list.sort((a,b)=>a.title.localeCompare(b.title,'fr'));
  else if (sortF==='note')  list.sort((a,b)=>(b.note||0)-(a.note||0));
  else list.sort((a,b)=>a.artist.localeCompare(b.artist,'fr'));

  const rows = [['Titre','Artiste','Album','Format','Bitrate','Écoutes last.fm','Note MB','Lové']];
  list.forEach(t => {
    const plays = lfExact.get(normalizeKey(t.artist,t.title))||0;
    const loved = _lovedTracks.has(normalizeKey(t.artist,t.title)) ? 'oui' : '';
    rows.push([t.title, t.artist, t.album||'', t.format||'', t.bitrate||'', plays||'', t.note||'', loved]);
  });
  _csvDownload(`morceaux_isoles_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} morceaux exportés ✓`);
}

// Tous les morceaux (filtres actifs)
function exportAllTracksCSV() {
  const lfExact = getLfExactMap();
  if (!_cache.albumById)   _cache.albumById   = new Map(albums.map(a=>[a.id,a]));
  if (!_cache.stockKeySet) _cache.stockKeySet = new Set(stockItems.map(s=>normalizeKey(s.artist,s.album)));
  if (!_cache.mbNoteByKey) {
    _cache.mbNoteByKey = new Map();
    albums.forEach(a => {
      const mbT = (albumTracksCache[a.id]||[]).filter(t=>t.source==='musicbee');
      const maxR = Math.max(0,...mbT.map(t=>t.rating||0));
      if (maxR) _cache.mbNoteByKey.set(normalizeKey(a.artist,a.album), maxR);
    });
    tracks.forEach(t => { if(t.note) _cache.mbNoteByKey.set(normalizeKey(t.artist,t.title),t.note); });
  }
  const q       = (document.getElementById('global-search').value||'').toLowerCase();
  const af      = (document.getElementById('filter-at-artist')?.value||'').toLowerCase().trim();
  const tf      = (document.getElementById('filter-at-title')?.value||'').toLowerCase().trim();
  const albf    = (document.getElementById('filter-at-album')?.value||'').toLowerCase().trim();
  const sf      = document.getElementById('filter-at-source')?.value||'';
  const folder  = document.getElementById('filter-at-folder')?.value||'';
  const nfOp    = document.getElementById('filter-at-note-op')?.value||'';
  const nfVal   = document.getElementById('filter-at-note-val')?.value||'';
  const minPlays= parseInt(document.getElementById('filter-at-min-plays')?.value||'0')||0;
  const lovedF  = document.getElementById('filter-at-loved')?.value||'';
  const bitrateF= document.getElementById('filter-at-bitrate')?.value||'';
  const albumById   = _cache.albumById;
  const stockKeySet = _cache.stockKeySet;

  const list = buildAllTracksList().filter(t => {
    if (q && !(t.title+' '+t.artist+' '+t.album).toLowerCase().includes(q)) return false;
    if (af   && !t.artist.toLowerCase().includes(af))  return false;
    if (tf   && !t.title.toLowerCase().includes(tf))   return false;
    if (albf && !t.album.toLowerCase().includes(albf)) return false;
    if (sf) { if(sf==='musicbee'&&t.source!=='musicbee') return false; if(sf==='isolated'&&t.source!=='isolated') return false; }
    if (folder) {
      if (folder==='isolated') { if(t.source!=='isolated') return false; }
      else if (folder==='stock') { const a=t.albumId?albumById.get(t.albumId):null; if(!t.inStock&&!(a&&stockKeySet.has(normalizeKey(a.artist,a.album)))) return false; }
      else { const a=t.albumId?albumById.get(t.albumId):null; if(!a) return false;
        if(folder==='discographie'&&!(a.cd||a.flac||a.mp3)) return false;
        if(folder==='ok'&&!a.okFolder) return false; if(folder==='forsale'&&!a.forSale) return false; if(folder==='discogs'&&!a.cd) return false; }
    }
    if (nfOp) { const note=t.note||_cache.mbNoteByKey.get(normalizeKey(t.artist,t.title))||0; if(!matchNoteFilter(nfOp,nfVal,note)) return false; }
    if (minPlays>0 && (lfExact.get(normalizeKey(t.artist,t.title))||0)<minPlays) return false;
    if (lovedF==='loved'   && !_lovedTracks.has(normalizeKey(t.artist,t.title))) return false;
    if (lovedF==='present' && !(lfExact.get(normalizeKey(t.artist,t.title))||0))  return false;
    if (bitrateF==='le320' && !(t.bitrate && t.bitrate<=320)) return false;
    if (bitrateF==='lt320' && !(t.bitrate && t.bitrate<320))  return false;
    if (bitrateF==='none'  && t.bitrate) return false;
    return true;
  });

  const rows = [['Titre','Artiste','Album','Source','Dossier','Note MB','Écoutes','Bitrate','Lové']];
  list.forEach(t => {
    const plays = lfExact.get(normalizeKey(t.artist,t.title))||0;
    const note  = t.note||_cache.mbNoteByKey.get(normalizeKey(t.artist,t.title))||'';
    const loved = _lovedTracks.has(normalizeKey(t.artist,t.title))?'oui':'';
    const fol   = t.inStock?'stock':(()=>{ const a=t.albumId?albumById.get(t.albumId):null; if(!a) return t.source==='isolated'?'top':''; if(a.forSale) return 'vendre'; if(a.okFolder) return 'ok'; if(a.cd) return 'discogs'; return 'album'; })();
    rows.push([t.title, t.artist, t.album||'', t.source, fol, note, plays||'', t.bitrate||'', loved]);
  });
  _csvDownload(`tous_morceaux_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} morceaux exportés ✓`);
}

// Morceaux des albums (filtres actifs)
function exportAlbumTracksCSV() {
  const lfExact = getLfExactMap();
  const q       = (document.getElementById('global-search').value||'').toLowerCase();
  const af      = (document.getElementById('filter-abt-artist')?.value||'').toLowerCase().trim();
  const tf      = (document.getElementById('filter-abt-title')?.value||'').toLowerCase().trim();
  const albf    = (document.getElementById('filter-abt-album')?.value||'').toLowerCase().trim();
  const nf      = document.getElementById('filter-abt-note')?.value||'';
  const minPlays= parseInt(document.getElementById('filter-abt-min-plays')?.value||'0')||0;
  const lovedF  = document.getElementById('filter-abt-loved')?.value||'';

  const list = buildAlbumTracksList().filter(t => {
    if (q && !(t.title+' '+t.artist+' '+t.album).toLowerCase().includes(q)) return false;
    if (af   && !t.artist.toLowerCase().includes(af))  return false;
    if (tf   && !t.title.toLowerCase().includes(tf))   return false;
    if (albf && !t.album.toLowerCase().includes(albf)) return false;
    if (nf) { const r=t.rating||0; if(nf==='5'&&r!==5) return false; if(nf==='4'&&r<4) return false; if(nf==='3'&&r<3) return false; if(nf==='0'&&r>0) return false; }
    if (minPlays>0 && (lfExact.get(normalizeKey(t.artist,t.title))||0)<minPlays) return false;
    if (lovedF==='loved'   && !_lovedTracks.has(normalizeKey(t.artist,t.title))) return false;
    if (lovedF==='present' && !(lfExact.get(normalizeKey(t.artist,t.title))||0))  return false;
    return true;
  });

  const rows = [['Titre','Artiste','Album','Note MB','Écoutes','Bitrate','Durée','Lové']];
  list.forEach(t => {
    const plays = lfExact.get(normalizeKey(t.artist,t.title))||0;
    const loved = _lovedTracks.has(normalizeKey(t.artist,t.title))?'oui':'';
    rows.push([t.title, t.artist, t.album, t.rating||'', plays||'', t.bitrate||'', t.duration||'', loved]);
  });
  _csvDownload(`morceaux_albums_${new Date().toISOString().slice(0,10)}.csv`, rows);
  toast(`${list.length} pistes exportées ✓`);
}

function exportJSON() {
  const data = JSON.stringify({
    albums, tracks, stockItems, lastfmData, rymData,
    associations, rymAssociations, nextId,
    exportedAt: new Date().toISOString(),
    version: 2
  }, null, 2);
  download('discothèque_backup.json', data, 'application/json');
  toast('Export JSON téléchargé ✓');
}

async function reimportJSON(input) {
  const file = input.files[0]; if (!file) return;
  const status = document.getElementById('status-json-reimport');
  status.textContent = 'Lecture…'; status.className = 'status';
  try {
    const text = await readFile(file);
    const data = JSON.parse(text);

    if (!data.albums && !data.tracks) {
      status.textContent = 'Erreur : fichier JSON invalide (aucune donnée albums ou tracks trouvée)';
      status.className = 'status err';
      input.value = '';
      return;
    }

    const summary = [];

    if (!confirm(`Restaurer depuis "${file.name}" ?\n\nCela remplacera :\n- ${(data.albums||[]).length} albums\n- ${(data.tracks||[]).length} morceaux isolés\n- ${(data.stockItems||[]).length} albums en stock\n- ${(data.rymData||[]).length} ratings RYM\n- ${(data.lastfmData||[]).length} entrées last.fm\n\nVotre collection actuelle sera écrasée.`)) {
      input.value = '';
      return;
    }

    // Restaurer toutes les données
    albums = data.albums || [];
    tracks = data.tracks || [];
    stockItems = data.stockItems || [];
    rymData = data.rymData || [];
    associations = data.associations || [];
    rymAssociations = data.rymAssociations || [];
    nextId = Math.max(nextId, data.nextId || 0, computeNextId());
    if (repairDuplicateIds()) saveToStorage();

    // lastfmData — peut être énorme, restaurer quand même
    if (data.lastfmData?.length) {
      lastfmData = data.lastfmData;
      summary.push(`${lastfmData.length} entrées last.fm`);
    }

    summary.unshift(
      `${albums.length} albums`,
      `${tracks.length} morceaux`,
      `${stockItems.length} en stock`,
      `${rymData.length} ratings RYM`
    );

    invalidateCache();
    renderAlbums();
    renderTracks();
    updateNavBadges();
    saveToStorage();

    status.textContent = `✓ Restauré : ${summary.join(', ')}`;
    status.className = 'status ok';
    toast('Collection restaurée depuis JSON ✓');
  } catch(e) {
    status.textContent = 'Erreur : ' + e.message;
    status.className = 'status err';
  }
  input.value = '';
}

// ===================== EXPORT OFFLINE ANDROID =====================
// Génère un fichier HTML autonome (données JSON embarquées, vanilla JS, aucune dépendance
// réseau/CDN) consultable dans Chrome Android sans connexion. Contient uniquement les
// albums (pas les morceaux isolés ni les scrobbles bruts last.fm) mais avec les notes
// croisées Discogs/MusicBrainz/RYM/last.fm déjà résolues dans l'app.

// Entrées RYM notées OU last.fm scrobblées mais absentes de la collection (todo-adjacent,
// demandé par Antoine) — fusionnées en une seule liste par artiste+album (un album peut être
// à la fois noté sur RYM et scrobblé sur last.fm sans être possédé). Contrairement à
// computeRYMMissing() (onglet ⭐ RYM), AUCUN seuil de note n'est appliqué ici : l'export offline
// est un inventaire de référence, pas une liste d'action, donc pas de raison d'en cacher une
// partie. Réutilise getOwnedRymKeys()/computeMissing() (mêmes définitions d'ownership déjà
// établies ailleurs dans l'app) plutôt que de redéfinir un 3e critère "possédé" divergent.
function computeOutOfCollectionEntries() {
  const combined = new Map(); // normalizeKey(artist,album) → entrée fusionnée

  // --- RYM : tout ce qui n'est pas possédé, noté ou non ---
  if (rymData.length) {
    const { keys: ownedKeys, mbIds: ownedMbIds } = getOwnedRymKeys();
    const associatedRymKeys = new Set(rymAssociations.map(a => a.rymKey));
    rymData.forEach(r => {
      if (!r.artist || !r.album) return;
      const albumNorm = normalizeKey('', r.album).replace('|||', '');
      for (const av of artistVariants(r.artist)) {
        if (ownedKeys.has(av + '|||' + albumNorm)) return; // possédé → exclu
      }
      const key = normalizeKey(r.artist, r.album);
      if (associatedRymKeys.has(key)) return;              // associé manuellement → possédé
      if (r.mb_release_id && ownedMbIds.has(r.mb_release_id)) return;
      const entry = combined.get(key) || { artist: r.artist, album: r.album, year: '', genre: '', noteRYM: '', plays: 0 };
      if (r.rating) entry.noteRYM = r.rating;
      if (!entry.year && r.year) entry.year = r.year;
      if (!entry.genre && r.genre) entry.genre = r.genre;
      combined.set(key, entry);
    });
  }

  // --- last.fm : réutilise computeMissing() (onglet Manquants), déjà dédupliqué/filtré non-possédé ---
  computeMissing().forEach(d => {
    const key = normalizeKey(d.artist, d.album);
    const entry = combined.get(key) || { artist: d.artist, album: d.album, year: '', genre: '', noteRYM: '', plays: 0 };
    entry.plays = d.plays || 0;
    combined.set(key, entry);
  });

  return [...combined.values()].sort((a, b) => (b.plays - a.plays) || ((b.noteRYM || 0) - (a.noteRYM || 0)));
}

function exportOfflineAndroid() {
  const list = albums.map(a => ({
    artist: a.artist, album: a.album,
    year: a.year || '', genre: a.genre || '',
    folders: a.folders || [],
    format: a.format || (a.flac ? 'flac' : a.mp3 ? 'mp3' : a.digital ? 'digital' : ''),
    cd: !!(a.cd || a.has_cd),
    noteMB: a.note || 0,
    noteDiscogs: a.discogsRating || 0,
    noteRYM: _rymRating(a.artist, a.album) || '',
    plays: a.plays || 0,
    label: a.label || '', catno: a.catno || '',
    isCompilation: !!a.isCompilation,
    outOfCollection: false,
  }));
  // Hors collection : RYM/last.fm sans DC/MB (pas d'album possédé, donc pas de note perso
  // MusicBee ni de note Discogs personnelle — seule la note RYM et les écoutes last.fm existent).
  const extra = computeOutOfCollectionEntries().map(e => ({
    artist: e.artist, album: e.album,
    year: e.year || '', genre: e.genre || '',
    folders: [], format: '', cd: false,
    noteMB: 0, noteDiscogs: 0, noteRYM: e.noteRYM || '',
    plays: e.plays || 0,
    label: '', catno: '', isCompilation: false,
    outOfCollection: true,
  }));
  const fullList = [...list, ...extra];
  const html = buildOfflineHtml(fullList);
  download(`collection-offline-${new Date().toISOString().slice(0,10)}.html`, html, 'text/html');
  toast(`📱 Export offline créé — ${list.length} possédés + ${extra.length} hors collection (${Math.round(html.length/1024)} Ko)`);
}

function buildOfflineHtml(list) {
  const genDate = new Date().toLocaleString('fr-FR');
  const dataJson = JSON.stringify(list);
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="fr">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Ma collection (hors ligne)</title>',
    '<style>',
    ':root{--bg:#111214;--bg2:#1a1b1e;--bg3:#222327;--text:#eee;--text2:#aaa;--text3:#777;--accent:#8b5cf6;--border:#333;--amber:#f5b642}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}',
    'header{position:sticky;top:0;background:var(--bg2);padding:10px 12px;border-bottom:1px solid var(--border);z-index:10}',
    'h1{font-size:14px;margin:0 0 8px;font-weight:600}',
    '.row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}',
    'input,select{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 8px;font-size:13px}',
    'input[type=text]{flex:1;min-width:140px}',
    '#counter{font-size:11px;color:var(--text3);margin-top:4px}',
    '#list{padding:8px}',
    '.card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:7px}',
    '.card.oc{border-style:dashed;opacity:0.85}',
    '.title{font-size:14px;font-weight:600}',
    '.sub{font-size:12px;color:var(--text2);margin-top:2px}',
    '.badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}',
    '.badge{font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:var(--text2);border:1px solid var(--border)}',
    '.badge.oc{background:transparent;color:var(--amber);border-color:var(--amber)}',
    '.empty{text-align:center;color:var(--text3);padding:40px 10px;font-size:13px}',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<h1>🎵 Ma collection — hors ligne (généré le ' + esc(genDate) + ')</h1>',
    '<div class="row"><input type="text" id="q" placeholder="Rechercher artiste / album…"></div>',
    '<div class="row">',
    '<select id="f-folder"><option value="">Tous dossiers</option><option value="discographie">Discographie</option><option value="ok">Ok</option><option value="stock">Stock</option><option value="forsale">Vendre</option></select>',
    '<select id="f-format"><option value="">Tous formats</option><option value="cd">CD</option><option value="flac">FLAC</option><option value="mp3">MP3</option><option value="digital">Digital</option></select>',
    '<select id="f-status"><option value="">Collection + hors collection</option><option value="in">En collection seulement</option><option value="out">🔭 Hors collection seulement</option></select>',
    '<select id="sort"><option value="artist">Tri : Artiste</option><option value="year">Tri : Année</option><option value="note">Tri : Note MB</option><option value="plays">Tri : Écoutes</option></select>',
    '</div>',
    '<div id="counter"></div>',
    '</header>',
    '<div id="list"></div>',
    '<script>',
    'const DATA = ' + dataJson + ';',
    "const q=document.getElementById('q'), fFolder=document.getElementById('f-folder'), fFormat=document.getElementById('f-format'), fStatus=document.getElementById('f-status'), sortSel=document.getElementById('sort'), listEl=document.getElementById('list'), counter=document.getElementById('counter');",
    "function norm(s){return (s||'').toString().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');}",
    "function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
    'function render(){',
    '  const query=norm(q.value.trim());',
    '  const folder=fFolder.value, format=fFormat.value, status=fStatus.value, sort=sortSel.value;',
    '  let rows=DATA.filter(function(a){',
    "    if(query && norm(a.artist+' '+a.album).indexOf(query)===-1) return false;",
    "    if(status==='in' && a.outOfCollection) return false;",
    "    if(status==='out' && !a.outOfCollection) return false;",
    '    if(folder && (a.folders||[]).indexOf(folder)===-1) return false;',
    "    if(format==='cd' && !a.cd) return false;",
    "    if(format && format!=='cd' && a.format!==format) return false;",
    '    return true;',
    '  });',
    "  if(sort==='year') rows.sort(function(a,b){return (b.year||'').localeCompare(a.year||'');});",
    "  else if(sort==='note') rows.sort(function(a,b){return (b.noteMB||0)-(a.noteMB||0);});",
    "  else if(sort==='plays') rows.sort(function(a,b){return (b.plays||0)-(a.plays||0);});",
    "  else rows.sort(function(a,b){return a.artist.localeCompare(b.artist,'fr')||a.album.localeCompare(b.album,'fr');});",
    "  counter.textContent = rows.length.toLocaleString('fr-FR') + ' / ' + DATA.length.toLocaleString('fr-FR') + ' entrées';",
    '  const slice=rows.slice(0,300);',
    "  if(!slice.length){ listEl.innerHTML='<div class=\"empty\">Aucun résultat</div>'; return; }",
    '  listEl.innerHTML = slice.map(function(a){',
    '    const badges=[];',
    "    if(a.outOfCollection) badges.push('<span class=\"badge oc\">🔭 Hors collection</span>');",
    "    if(a.cd) badges.push('<span class=\"badge\">💿 CD</span>');",
    "    if(a.format==='flac') badges.push('<span class=\"badge\">FLAC</span>');",
    "    if(a.format==='mp3') badges.push('<span class=\"badge\">MP3</span>');",
    "    if(a.format==='digital') badges.push('<span class=\"badge\">Digital</span>');",
    "    if(a.noteMB) badges.push('<span class=\"badge\">MB '+a.noteMB+'★</span>');",
    "    if(a.noteRYM) badges.push('<span class=\"badge\">RYM '+a.noteRYM+'</span>');",
    "    if(a.noteDiscogs) badges.push('<span class=\"badge\">Discogs '+a.noteDiscogs+'</span>');",
    "    if(a.plays) badges.push('<span class=\"badge\">'+a.plays.toLocaleString('fr-FR')+' écoutes</span>');",
    "    return '<div class=\"card'+(a.outOfCollection?' oc':'')+'\"><div class=\"title\">'+esc(a.album)+'</div><div class=\"sub\">'+esc(a.artist)+(a.year?' · '+esc(a.year):'')+(a.genre?' · '+esc(a.genre):'')+'</div><div class=\"badges\">'+badges.join('')+'</div></div>';",
    "  }).join('') + (rows.length>300 ? '<div class=\"empty\">… '+(rows.length-300).toLocaleString('fr-FR')+' de plus — affine la recherche</div>' : '');",
    '}',
    "q.addEventListener('input', render);",
    "fFolder.addEventListener('change', render);",
    "fFormat.addEventListener('change', render);",
    "fStatus.addEventListener('change', render);",
    "sortSel.addEventListener('change', render);",
    'render();',
    '<' + '/script>',
    '</body>',
    '</html>',
  ];
  return lines.join('\n');
}

function download(filename, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
}

function clearAll() {
  if (!confirm('Vider toute la collection ET effacer la sauvegarde locale ?')) return;
  albums = []; tracks = []; stockItems = []; lastfmData = []; rymData = []; associations = []; rymAssociations = [];
  localStorage.removeItem(LS_KEY);
  if (window._db) {
    window._db.collection('discotheque').doc('collection').delete().catch(()=>{});
  }
  setSaveIndicator('none');
  renderAlbums(); renderTracks(); updateNavBadges();
  toast('Collection vidée');
}

// ===================== DEMO DATA =====================
function loadDemo() {
  albums = [
    { id: uid(), artist: 'Miles Davis', album: 'Kind of Blue', year: '1959', genre: 'Jazz', cd: true, flac: true, mp3: false, digital: false, note: 5, plays: 42, notes: '' },
    { id: uid(), artist: 'Pink Floyd', album: 'The Dark Side of the Moon', year: '1973', genre: 'Rock', cd: true, flac: false, mp3: false, digital: false, note: 5, plays: 28, notes: '' },
    { id: uid(), artist: 'Daft Punk', album: 'Random Access Memories', year: '2013', genre: 'Électro', cd: false, flac: true, mp3: false, digital: false, note: 4, plays: 55, notes: '' },
    { id: uid(), artist: 'Massive Attack', album: 'Mezzanine', year: '1998', genre: 'Trip-hop', cd: true, flac: true, mp3: false, digital: false, note: 5, plays: 19, notes: '' },
    { id: uid(), artist: 'Radiohead', album: 'OK Computer', year: '1997', genre: 'Rock', cd: false, flac: false, mp3: true, digital: false, note: 4, plays: 31, notes: '' },
    { id: uid(), artist: 'Björk', album: 'Homogenic', year: '1997', genre: 'Art pop', cd: false, flac: true, mp3: false, digital: false, note: 0, plays: 12, notes: '' },
    { id: uid(), artist: 'Can', album: 'Tago Mago', year: '1971', genre: 'Krautrock', cd: true, flac: false, mp3: false, digital: false, note: 5, plays: 8, notes: 'Édition originale United Artists' },
    { id: uid(), artist: 'John Coltrane', album: 'A Love Supreme', year: '1964', genre: 'Jazz', cd: true, flac: true, mp3: false, digital: false, note: 5, plays: 37, notes: '' },
    { id: uid(), artist: 'Portishead', album: 'Dummy', year: '1994', genre: 'Trip-hop', cd: true, flac: false, mp3: false, digital: false, note: 5, plays: 22, notes: '' },
    { id: uid(), artist: 'Aphex Twin', album: 'Selected Ambient Works 85-92', year: '1992', genre: 'Électro', cd: false, flac: true, mp3: false, digital: false, note: 4, plays: 15, notes: '' },
  ];
  tracks = [
    { id: uid(), title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', format: 'mp3', duration: '5:20', note: 5 },
    { id: uid(), title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', format: 'flac', duration: '5:30', note: 4 },
    { id: uid(), title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', format: 'flac', duration: '4:21', note: 5 },
  ];
  lastfmData = [
    { artist: 'Burial', album: 'Untrue', plays: 18 },
    { artist: 'The xx', album: 'xx', plays: 14 },
    { artist: 'Four Tet', album: 'There Is Love In You', plays: 11 },
    { artist: 'Portishead', album: 'Third', plays: 9 },
  ];
}

// ===================== ASSOCIATION RYM DEPUIS COLLECTION =====================
let _rfcTargetAlbumId = null; // album de la collection qu'on veut lier à RYM

function openRYMAssocFromCollection(albumId) {
  const realId = unsid(albumId);
  const album = albums.find(a => a.id === realId);
  if (!album) return;
  _rfcTargetAlbumId = realId;

  document.getElementById('rfc-album-info').innerHTML =
    `<strong>Collection :</strong> ${esc(album.album)} — ${esc(album.artist)}`
    + (album.year ? ` <span style="color:var(--text3);font-size:11px">${album.year}</span>` : '');

  // Pré-remplir la recherche avec l'artiste (nettoyé)
  document.getElementById('rfc-search').value = cleanDiscogsArtist(album.artist);

  // Bouton "supprimer association" si déjà liée
  const existingAssoc = rymAssociations.find(a => a.albumKey === albumId);
  const unlinkBtn = document.getElementById('rfc-unlink-btn');
  if (unlinkBtn) unlinkBtn.style.display = existingAssoc ? '' : 'none';

  renderRFCList();
  document.getElementById('modal-rym-from-collection').classList.add('open');
}

function renderRFCList() {
  const q = (document.getElementById('rfc-search').value || '').toLowerCase().trim();
  const album = albums.find(a => a.id === _rfcTargetAlbumId);
  if (!rymData.length) {
    document.getElementById('rfc-list').innerHTML =
      '<div style="color:var(--text3);font-size:12px;padding:8px">Aucune donnée RYM chargée — importez d\'abord votre collection RYM.</div>';
    return;
  }

  // Scorer chaque entrée RYM par similarité avec l'album cible
  const albumNormTarget = album ? normalizeKey('', album.album).replace('|||', '') : '';
  const artistNormTarget = album ? normalizeKey(cleanDiscogsArtist(album.artist), '').replace('|||', '') : '';
  const artistVariantsTarget = album ? artistVariants(album.artist) : new Set();

  const scored = rymData
    .filter(r => {
      if (!q) return true;
      return (r.artist + ' ' + r.album).toLowerCase().includes(q);
    })
    .map(r => {
      const rAlbumNorm  = normalizeKey('', r.album).replace('|||', '');
      const rArtistNorm = normalizeKey(cleanDiscogsArtist(r.artist), '').replace('|||', '');
      let score = 0;
      // Titre album
      if (rAlbumNorm === albumNormTarget) score += 4;
      else if (albumNormTarget && (rAlbumNorm.includes(albumNormTarget) || albumNormTarget.includes(rAlbumNorm))) score += 2;
      // Artiste
      if (rArtistNorm === artistNormTarget) score += 3;
      else {
        for (const av of artistVariants(r.artist)) {
          if (artistVariantsTarget.has(av)) { score += 2; break; }
        }
        if (artistNormTarget && rArtistNorm.includes(artistNormTarget)) score += 1;
      }
      return { r, score };
    })
    .sort((a, b) => b.score - a.score || a.r.artist.localeCompare(b.r.artist, 'fr'))
    .slice(0, 80);

  // Association courante
  const currentAssoc = rymAssociations.find(a => a.albumKey === _rfcTargetAlbumId);

  const el = document.getElementById('rfc-list');
  if (!scored.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Aucun résultat</div>';
    return;
  }

  el.innerHTML = scored.map(({ r, score }) => {
    const rymKey = normalizeKey(r.artist, r.album);
    const isCurrent = currentAssoc?.rymKey === rymKey;
    const isLinkedElsewhere = !isCurrent && rymAssociations.some(a => a.rymKey === rymKey);
    const bg = isCurrent ? 'var(--accent-dim)' : score >= 5 ? 'rgba(200,240,100,0.06)' : 'var(--bg3)';
    const border = isCurrent ? 'rgba(200,240,100,0.3)' : score >= 5 ? 'rgba(200,240,100,0.15)' : 'var(--border)';
    const matchLabel = score >= 7 ? '✅ match fort' : score >= 4 ? '≈ match probable' : score >= 2 ? '~ similaire' : '';
    const matchColor = score >= 7 ? 'var(--accent)' : score >= 4 ? 'var(--amber)' : 'var(--text3)';
    const ratingHtml = r.rating
      ? `<span style="font-family:var(--mono);font-size:12px;color:var(--amber)">${r.rating.toFixed(2)}★</span>`
      : `<span style="color:var(--text3);font-size:11px">non noté</span>`;
    const linkedBadge = isLinkedElsewhere
      ? '<span style="font-size:10px;color:var(--text3);margin-left:6px">déjà associé</span>' : '';
    return `<div onclick="applyRFCAssoc('${rymKey.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')"
      style="background:${bg};border:1px solid ${border};border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${esc(r.album)}${isCurrent ? ' <span style="font-size:10px;color:var(--accent)">● actuel</span>' : ''}${linkedBadge}
        </div>
        <div style="font-size:11px;color:var(--text2)">${esc(r.artist)}${r.year ? ' · ' + r.year : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">
        ${ratingHtml}
        ${matchLabel ? `<span style="font-size:10px;color:${matchColor};font-family:var(--mono)">${matchLabel}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function applyRFCAssoc(rymKey) {
  if (!_rfcTargetAlbumId) return;
  // Supprimer toute association existante pour cet album ou cette clé RYM
  rymAssociations = rymAssociations.filter(a => a.albumKey !== _rfcTargetAlbumId && a.rymKey !== rymKey);
  rymAssociations.push({ rymKey, albumKey: _rfcTargetAlbumId });
  document.getElementById('modal-rym-from-collection').classList.remove('open');
  invalidateCache();
  saveToStorage();
  renderAlbums();
  updateNavBadges();
  const rEntry = rymData.find(r => normalizeKey(r.artist, r.album) === rymKey);
  toast(`⭐ RYM lié : ${rEntry ? rEntry.artist + ' — ' + rEntry.album : rymKey}`);
  _rfcTargetAlbumId = null;
}

function unlinkRYMFromCollection() {
  if (!_rfcTargetAlbumId) return;
  if (!confirm('Supprimer l\'association RYM pour cet album ?')) return;
  rymAssociations = rymAssociations.filter(a => a.albumKey !== _rfcTargetAlbumId);
  document.getElementById('modal-rym-from-collection').classList.remove('open');
  invalidateCache();
  saveToStorage();
  renderAlbums();
  updateNavBadges();
  toast('Association RYM supprimée');
  _rfcTargetAlbumId = null;
}

// ===================== FUSION MANUELLE DE FICHES ALBUM =====================
// Sert notamment à fusionner deux entrées d'un même album (ex: CD Discogs + fichier
// numérique MusicBee) restées séparées faute de clé identique — ce qui empêche aussi
// certaines notes MB/DC/RYM de s'afficher car elles ne sont attachées qu'à une seule ligne.
let _mergeSourceId = null;

function openMergeAlbumModal(albumId) {
  const realId = unsid(albumId);
  const album = albums.find(a => a.id === realId);
  if (!album) return;
  _mergeSourceId = realId;

  document.getElementById('merge-album-info').innerHTML =
    `<strong>Fiche source :</strong> ${esc(album.album)} — ${esc(album.artist)}`
    + (album.year ? ` <span style="color:var(--text3);font-size:11px">${album.year}</span>` : '');

  document.getElementById('merge-search').value = album.album;
  renderMergeAlbumList();
  document.getElementById('modal-merge-album').classList.add('open');
  setTimeout(() => document.getElementById('merge-search').focus(), 150);
}

function closeMergeAlbumModal() {
  document.getElementById('modal-merge-album').classList.remove('open');
  _mergeSourceId = null;
}

function renderMergeAlbumList() {
  const q = (document.getElementById('merge-search').value || '').toLowerCase().trim();
  const src = albums.find(a => a.id === _mergeSourceId);
  const el = document.getElementById('merge-list');
  if (!src) { el.innerHTML = ''; return; }

  const albumNormTarget = normalizeKey('', src.album).replace('|||', '');
  const artistNormTarget = normalizeKey(cleanDiscogsArtist(src.artist), '').replace('|||', '');
  const artistVariantsTarget = artistVariants(src.artist);

  const scored = albums
    .filter(a => a.id !== src.id)
    .filter(a => {
      if (!q) return true;
      return (a.artist + ' ' + a.album).toLowerCase().includes(q);
    })
    .map(a => {
      const aAlbumNorm  = normalizeKey('', a.album).replace('|||', '');
      const aArtistNorm = normalizeKey(cleanDiscogsArtist(a.artist), '').replace('|||', '');
      let score = 0;
      if (aAlbumNorm === albumNormTarget) score += 4;
      else if (albumNormTarget && (aAlbumNorm.includes(albumNormTarget) || albumNormTarget.includes(aAlbumNorm))) score += 2;
      if (aArtistNorm === artistNormTarget) score += 3;
      else {
        for (const av of artistVariants(a.artist)) {
          if (artistVariantsTarget.has(av)) { score += 2; break; }
        }
        if (artistNormTarget && aArtistNorm.includes(artistNormTarget)) score += 1;
      }
      return { a, score };
    })
    .sort((x, y) => y.score - x.score || x.a.artist.localeCompare(y.a.artist, 'fr'))
    .slice(0, 80);

  if (!scored.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Aucun résultat</div>';
    return;
  }

  el.innerHTML = scored.map(({ a, score }) => {
    const badges = [
      a.cd      ? '<span class="badge badge-cd">💿 CD</span>' : '',
      a.flac    ? '<span class="badge badge-flac">FLAC</span>' : '',
      a.mp3     ? '<span class="badge badge-mp3">MP3</span>' : '',
      a.digital ? '<span class="badge badge-digital">Digital</span>' : '',
    ].filter(Boolean).join('');
    const matchLabel = score >= 7 ? '✅ match fort' : score >= 4 ? '≈ match probable' : score >= 2 ? '~ similaire' : '';
    const matchColor = score >= 7 ? 'var(--accent)' : score >= 4 ? 'var(--amber)' : 'var(--text3)';
    const bg = score >= 5 ? 'rgba(200,240,100,0.06)' : 'var(--bg3)';
    const border = score >= 5 ? 'rgba(200,240,100,0.15)' : 'var(--border)';
    return `<div style="background:${bg};border:1px solid ${border};border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.album)}</div>
        <div style="font-size:11px;color:var(--text2);display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px">
          <span>${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</span>
          ${badges}
          ${matchLabel ? `<span style="font-size:10px;color:${matchColor};font-family:var(--mono)">${matchLabel}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-sm btn-accent" onclick="confirmMergeAlbums('${sid(a.id)}')" style="flex-shrink:0">Fusionner</button>
    </div>`;
  }).join('');
}

function confirmMergeAlbums(targetAlbumId) {
  const targetId = unsid(targetAlbumId);
  const src = albums.find(a => a.id === _mergeSourceId);
  const tgt = albums.find(a => a.id === targetId);
  if (!src || !tgt) return;
  if (!confirm(`Fusionner "${src.artist} — ${src.album}" avec "${tgt.artist} — ${tgt.album}" ?\n\nLes supports, notes et métadonnées seront combinés en une seule fiche. Action irréversible.`)) return;

  mergeAlbumsManual(src.id, tgt.id);
  closeMergeAlbumModal();
  invalidateCache();
  renderAlbums();
  updateNavBadges();
  saveToStorage();
  toast('Fiches fusionnées ✓');
}

// Fusionne sourceId dans targetId : combine supports, notes (MB/DC/RYM), métadonnées,
// repointe les associations RYM/Discogs, puis supprime la fiche source.
function mergeAlbumsManual(sourceId, targetId) {
  if (sourceId === targetId) return;
  const src = albums.find(a => a.id === sourceId);
  const tgt = albums.find(a => a.id === targetId);
  if (!src || !tgt) return;

  // Supports
  tgt.cd      = tgt.cd      || src.cd;
  tgt.has_cd  = tgt.has_cd  || src.has_cd || tgt.cd;
  tgt.flac    = tgt.flac    || src.flac;
  tgt.mp3     = tgt.mp3     || src.mp3;
  tgt.digital = tgt.digital || src.digital;
  if (!tgt.format && src.format) tgt.format = src.format;

  // Métadonnées manquantes
  if (!tgt.year  && src.year)  { tgt.year  = src.year;  carryProvenance(tgt, src, 'year'); }
  if (!tgt.genre && src.genre) { tgt.genre = src.genre; carryProvenance(tgt, src, 'genre'); }
  if (!tgt.note  && src.note)  tgt.note  = src.note; // note MB (MusicBee)
  if (!tgt.discogsRating && src.discogsRating) tgt.discogsRating = src.discogsRating;
  if (!tgt.discogsId     && src.discogsId)     tgt.discogsId     = src.discogsId;
  if (!tgt.mb_release_id && src.mb_release_id) tgt.mb_release_id = src.mb_release_id;
  if (!tgt.label  && src.label)  { tgt.label  = src.label;  carryProvenance(tgt, src, 'label'); }
  if (!tgt.catno  && src.catno)  tgt.catno  = src.catno;
  if (!tgt.cover_url && src.cover_url) { tgt.cover_url = src.cover_url; carryProvenance(tgt, src, 'cover_url'); }
  if (src.notes) tgt.notes = tgt.notes ? (tgt.notes + '\n' + src.notes) : src.notes;

  tgt.plays = (tgt.plays || 0) + (src.plays || 0);
  tgt.okFolder = tgt.okFolder || src.okFolder;
  tgt.forSale  = tgt.forSale  || src.forSale;
  tgt.isCompilation = tgt.isCompilation || src.isCompilation;
  (src.folders || []).forEach(f => {
    if (!tgt.folders) tgt.folders = [];
    if (!tgt.folders.includes(f)) tgt.folders.push(f);
  });

  // Variantes d'artiste (utile pour le matching last.fm)
  if (src.lastfmAliases?.length || src.artist !== tgt.artist) {
    const extra = new Set([...(tgt.lastfmAliases || []), ...(src.lastfmAliases || [])]);
    if (src.artist && src.artist !== tgt.artist) extra.add(src.artist);
    tgt.lastfmAliases = [...extra];
  }

  // Mémoriser l'identité (artiste, album) de la fiche fusionnée-et-supprimée, pour que les
  // futurs réimports Discogs/MusicBee la reconnaissent au lieu de recréer une fiche en double
  // (cas typique : le tag artiste MusicBee diffère du nom Discogs au-delà de ce que
  // cleanDiscogsArtist() sait nettoyer, ex: "+/-" vs "+/- (Plus / Minus)").
  if (!tgt.mergedAliases) tgt.mergedAliases = [];
  if (src.artist !== tgt.artist || src.album !== tgt.album) {
    tgt.mergedAliases.push({ artist: src.artist, album: src.album });
  }
  if (src.mergedAliases?.length) tgt.mergedAliases.push(...src.mergedAliases);

  // Repointer l'association RYM éventuelle de la source vers la fiche conservée,
  // sans écraser une association RYM déjà présente sur la cible
  rymAssociations.forEach(x => { if (x.albumKey === src.id) x.albumKey = tgt.id; });
  const seenAlbumIds = new Set();
  rymAssociations = rymAssociations.filter(x => {
    if (x.albumKey !== tgt.id) return true;
    if (seenAlbumIds.has(x.albumKey)) return false;
    seenAlbumIds.add(x.albumKey);
    return true;
  });

  // Les associations CD/numérique Discogs référençant la source deviennent obsolètes
  associations = associations.filter(x => x.cdKey !== src.id && x.numKey !== src.id);

  // Retirer la fiche source
  albums = albums.filter(a => a.id !== src.id);
}

document.getElementById('modal-merge-album').addEventListener('click', function(e) {
  if (e.target === this) closeMergeAlbumModal();
});

// ===================== DÉTECTION DE DOUBLONS POTENTIELS =====================
// Repère les paires d'albums du même artiste dont le titre est quasi identique
// mais dont la clé normalisée diffère (donc pas fusionnés automatiquement) —
// typiquement CD + numérique restés séparés, ou un sous-titre entre parenthèses.
const DUP_IGNORE_KEY = 'discotheque_dup_ignored';

function _dupIgnoredSet() {
  try { return new Set(JSON.parse(localStorage.getItem(DUP_IGNORE_KEY) || '[]')); }
  catch(e) { return new Set(); }
}
function _dupIgnoreAdd(pairKey) {
  const s = _dupIgnoredSet();
  s.add(pairKey);
  localStorage.setItem(DUP_IGNORE_KEY, JSON.stringify([...s]));
}
function _dupPairKey(idA, idB) {
  return [idA, idB].sort().join('¤');
}

// Titre "nettoyé" : enlève le contenu entre parenthèses/crochets, la ponctuation,
// les mentions d'édition courantes, et compresse les espaces.
function _dupCleanTitle(title) {
  return String(title || '')
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\b(deluxe|remaster(ed)?|edition|reissue|bonus|version|explicit|ep|lp|expanded|anniversary)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}+/]+/gu, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function _dupTitleTokens(title) {
  return new Set(_dupCleanTitle(title).split(' ').filter(t => t.length > 1));
}

function _dupDiceScore(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  setA.forEach(t => { if (setB.has(t)) inter++; });
  return (2 * inter) / (setA.size + setB.size);
}

function computeAlbumDuplicateCandidates() {
  const ignored = _dupIgnoredSet();
  const candidates = [];

  // Regroupe par artiste normalisé (variantes incluses) pour limiter les comparaisons
  const byArtist = new Map();
  albums.forEach(a => {
    const key = normalizeKey(cleanDiscogsArtist(a.artist), '').replace('|||', '');
    if (!byArtist.has(key)) byArtist.set(key, []);
    byArtist.get(key).push(a);
  });

  byArtist.forEach(list => {
    if (list.length < 2) return;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.id === b.id) continue;
        // Discogs IDs différents et tous deux renseignés → probable homonyme distinct, on ne suggère pas
        if (a.discogsId && b.discogsId && a.discogsId !== b.discogsId) continue;
        const pairKey = _dupPairKey(a.id, b.id);
        if (ignored.has(pairKey)) continue;

        const cleanA = _dupCleanTitle(a.album);
        const cleanB = _dupCleanTitle(b.album);
        if (!cleanA || !cleanB) continue;

        let score = 0, reason = '';
        if (cleanA === cleanB) { score = 10; reason = 'titre identique une fois nettoyé'; }
        else if (cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA)) { score = 7; reason = 'un titre préfixe de l\'autre'; }
        else {
          const dice = _dupDiceScore(_dupTitleTokens(a.album), _dupTitleTokens(b.album));
          if (dice >= 0.6) { score = 5; reason = 'mots du titre très proches'; }
        }
        if (score > 0) candidates.push({ a, b, score, reason, pairKey });
      }
    }
  });

  return candidates.sort((x, y) => y.score - x.score);
}

function openDupFinderModal() {
  renderDupFinderList();
  document.getElementById('modal-dup-finder').classList.add('open');
}

function closeDupFinderModal() {
  document.getElementById('modal-dup-finder').classList.remove('open');
}

function renderDupFinderList() {
  const candidates = computeAlbumDuplicateCandidates();
  document.getElementById('dup-finder-counter').textContent =
    candidates.length ? `${candidates.length} paire${candidates.length > 1 ? 's' : ''} détectée${candidates.length > 1 ? 's' : ''}` : '';

  const el = document.getElementById('dup-finder-list');
  if (!candidates.length) {
    el.innerHTML = '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Aucun doublon potentiel détecté !</div>';
    return;
  }

  const fmtBadges = a => [
    a.cd      ? '<span class="badge badge-cd">💿 CD</span>' : '',
    a.flac    ? '<span class="badge badge-flac">FLAC</span>' : '',
    a.mp3     ? '<span class="badge badge-mp3">MP3</span>' : '',
    a.digital ? '<span class="badge badge-digital">Digital</span>' : '',
  ].filter(Boolean).join('');

  el.innerHTML = candidates.map(({ a, b, score, reason, pairKey }) => {
    const matchLabel = score >= 10 ? '✅ match fort' : score >= 7 ? '≈ match probable' : '~ similaire';
    const matchColor = score >= 10 ? 'var(--accent)' : score >= 7 ? 'var(--amber)' : 'var(--text3)';
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;color:${matchColor};font-family:var(--mono)">${matchLabel} — ${esc(reason)}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.album)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
          <div style="margin-top:4px">${fmtBadges(a) || '<span style="font-size:10px;color:var(--text3)">–</span>'}</div>
        </div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.album)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(b.artist)}${b.year ? ' · ' + b.year : ''}</div>
          <div style="margin-top:4px">${fmtBadges(b) || '<span style="font-size:10px;color:var(--text3)">–</span>'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
        <button class="btn btn-sm" onclick="dupFinderIgnore('${pairKey}')">Ignorer</button>
        <button class="btn btn-sm btn-accent" onclick="dupFinderMerge('${sid(a.id)}','${sid(b.id)}')">🔗 Fusionner</button>
      </div>
    </div>`;
  }).join('');
}

function dupFinderIgnore(pairKey) {
  _dupIgnoreAdd(pairKey);
  renderDupFinderList();
}

function dupFinderMerge(idA, idB) {
  const realA = unsid(idA), realB = unsid(idB);
  const a = albums.find(x => x.id === realA);
  const b = albums.find(x => x.id === realB);
  if (!a || !b) return;
  if (!confirm(`Fusionner "${a.artist} — ${a.album}" avec "${b.artist} — ${b.album}" ?\n\nAction irréversible.`)) return;
  mergeAlbumsManual(realA, realB);
  invalidateCache();
  renderAlbums();
  updateNavBadges();
  saveToStorage();
  renderDupFinderList();
  toast('Fiches fusionnées ✓');
}

document.getElementById('modal-dup-finder').addEventListener('click', function(e) {
  if (e.target === this) closeDupFinderModal();
});

// ===================== SUGGESTIONS D'ASSOCIATION CD ↔ NUMÉRIQUE =====================
// Repère les CD Discogs sans backup numérique (_cache.cdsWithoutBackup) qui ont un titre
// très proche d'un album numérique du même artiste, mais jamais formellement associés
// (bouton 🔗 sur Discographie) — réutilise le même scoring que le détecteur de doublons.
const CDASSOC_IGNORE_KEY = 'discotheque_cdassoc_ignored';

function _cdAssocIgnoredSet() {
  try { return new Set(JSON.parse(localStorage.getItem(CDASSOC_IGNORE_KEY) || '[]')); }
  catch(e) { return new Set(); }
}
function _cdAssocIgnoreAdd(pairKey) {
  const s = _cdAssocIgnoredSet();
  s.add(pairKey);
  localStorage.setItem(CDASSOC_IGNORE_KEY, JSON.stringify([...s]));
}

function computeCdAssocCandidates() {
  const ignored = _cdAssocIgnoredSet();
  const candidates = [];
  const alreadyLinkedNumKeys = new Set(associations.map(a => a.numKey));

  const cds = albums.filter(a => a.cd && !hasDigitalBackup(a));
  if (!cds.length) return candidates;

  // Regroupe les albums numériques par artiste normalisé (variantes incluses)
  const digitalByArtist = new Map();
  albums.filter(b => (b.flac || b.mp3 || b.digital) && !alreadyLinkedNumKeys.has(b.id)).forEach(b => {
    for (const av of artistVariants(cleanDiscogsArtist(b.artist))) {
      if (!digitalByArtist.has(av)) digitalByArtist.set(av, []);
      digitalByArtist.get(av).push(b);
    }
  });

  cds.forEach(a => {
    const avSet = artistVariants(cleanDiscogsArtist(a.artist));
    const seenIds = new Set();
    const pool = [];
    avSet.forEach(av => {
      (digitalByArtist.get(av) || []).forEach(b => {
        if (!seenIds.has(b.id)) { seenIds.add(b.id); pool.push(b); }
      });
    });
    if (!pool.length) return;

    const cleanA = _dupCleanTitle(a.album);
    if (!cleanA) return;

    let best = null;
    pool.forEach(b => {
      const cleanB = _dupCleanTitle(b.album);
      if (!cleanB) return;
      let score = 0, reason = '';
      if (cleanA === cleanB) { score = 10; reason = 'titre identique une fois nettoyé'; }
      else if (cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA)) { score = 7; reason = 'un titre préfixe de l\'autre'; }
      else {
        const dice = _dupDiceScore(_dupTitleTokens(a.album), _dupTitleTokens(b.album));
        if (dice >= 0.6) { score = 5; reason = 'mots du titre très proches'; }
      }
      if (score > 0 && (!best || score > best.score)) best = { b, score, reason };
    });
    if (!best) return;

    const pairKey = _dupPairKey(String(a.id), String(best.b.id));
    if (ignored.has(pairKey)) return;
    candidates.push({ a, b: best.b, score: best.score, reason: best.reason, pairKey });
  });

  return candidates.sort((x, y) => y.score - x.score);
}

function openCdAssocFinderModal() {
  renderCdAssocFinderList();
  document.getElementById('modal-cdassoc-finder').classList.add('open');
}

function closeCdAssocFinderModal() {
  document.getElementById('modal-cdassoc-finder').classList.remove('open');
}

function renderCdAssocFinderList() {
  const candidates = computeCdAssocCandidates();
  document.getElementById('cdassoc-finder-counter').textContent =
    candidates.length ? `${candidates.length} suggestion${candidates.length > 1 ? 's' : ''}` : '';

  const el = document.getElementById('cdassoc-finder-list');
  if (!candidates.length) {
    el.innerHTML = '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Aucune suggestion — tous les CD sans backup n\'ont pas de candidat numérique évident.</div>';
    return;
  }

  const fmtBadges = a => [
    a.cd      ? '<span class="badge badge-cd">💿 CD</span>' : '',
    a.flac    ? '<span class="badge badge-flac">FLAC</span>' : '',
    a.mp3     ? '<span class="badge badge-mp3">MP3</span>' : '',
    a.digital ? '<span class="badge badge-digital">Digital</span>' : '',
  ].filter(Boolean).join('');

  el.innerHTML = candidates.map(({ a, b, score, reason, pairKey }) => {
    const matchLabel = score >= 10 ? '✅ match fort' : score >= 7 ? '≈ match probable' : '~ similaire';
    const matchColor = score >= 10 ? 'var(--accent)' : score >= 7 ? 'var(--amber)' : 'var(--text3)';
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;color:${matchColor};font-family:var(--mono)">${matchLabel} — ${esc(reason)}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.album)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
          <div style="margin-top:4px">${fmtBadges(a) || '<span style="font-size:10px;color:var(--text3)">–</span>'}</div>
        </div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.album)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(b.artist)}${b.year ? ' · ' + b.year : ''}</div>
          <div style="margin-top:4px">${fmtBadges(b) || '<span style="font-size:10px;color:var(--text3)">–</span>'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
        <button class="btn btn-sm" onclick="cdAssocFinderIgnore('${pairKey}')">Ignorer</button>
        <button class="btn btn-sm btn-accent" onclick="cdAssocFinderConfirm('${sid(a.id)}','${sid(b.id)}')">🔗 Associer</button>
      </div>
    </div>`;
  }).join('');
}

function cdAssocFinderIgnore(pairKey) {
  _cdAssocIgnoreAdd(pairKey);
  renderCdAssocFinderList();
}

function cdAssocFinderConfirm(cdId, numId) {
  const realCd = unsid(cdId), realNum = unsid(numId);
  const cdAlbum = albums.find(x => x.id === realCd);
  const numAlbum = albums.find(x => x.id === realNum);
  if (!cdAlbum || !numAlbum) return;
  associations.push({ cdKey: cdAlbum.id, numKey: numAlbum.id });
  invalidateCache();
  renderDiscographie();
  renderAlbums();
  updateNavBadges();
  saveToStorage();
  renderCdAssocFinderList();
  toast(`Association créée : ${cdAlbum.artist} — ${cdAlbum.album} ↔ ${numAlbum.album}`);
}

document.getElementById('modal-cdassoc-finder').addEventListener('click', function(e) {
  if (e.target === this) closeCdAssocFinderModal();
});

// ===================== NETTOYAGE DOUBLONS LAST.FM =====================
// Fusionne les entrées last.fm (albums + morceaux) qui ne diffèrent que par la casse
// ou la ponctuation ("Luck In The Valley" vs "Luck in the Valley") — ces doublons
// s'accumulaient car Supabase upsertait sur le texte brut (sensible à la casse) au lieu
// d'une clé normalisée. Fusionne en mémoire (écoutes additionnées) puis remplace
// intégralement les tables côté Supabase pour purger les doublons déjà accumulés.
async function cleanupLastfmDuplicates() {
  if (!lastfmData.length && !Object.keys(_lastfmTrackCounts).length) {
    toast('Aucune donnée last.fm à nettoyer'); return;
  }

  // --- Albums ---
  const beforeAlbums = lastfmData.length;
  const lfDedup = new Map();
  lastfmData.forEach(d => {
    if (!d.artist || !d.album) return;
    const k = normalizeKey(d.artist, d.album);
    const prev = lfDedup.get(k);
    if (!prev) {
      lfDedup.set(k, { artist: d.artist, album: d.album, plays: d.plays || 0, _best: d.plays || 0 });
    } else {
      prev.plays += (d.plays || 0);
      if ((d.plays || 0) > prev._best) { prev._best = d.plays || 0; prev.artist = d.artist; prev.album = d.album; }
    }
  });
  lastfmData = [...lfDedup.values()].map(({ artist, album, plays }) => ({ artist, album, plays }));
  const removedAlbums = beforeAlbums - lastfmData.length;

  // --- Morceaux ---
  const beforeTracks = Object.keys(_lastfmTrackCounts).length;
  const ltDedup = new Map();
  Object.values(_lastfmTrackCounts).forEach(d => {
    if (!d.artist || !d.track) return;
    const k = normalizeKey(d.artist, d.track) + '|' + normalizeKey('', d.album || '');
    const prev = ltDedup.get(k);
    if (!prev) {
      ltDedup.set(k, { artist: d.artist, track: d.track, album: d.album || '', plays: d.plays || 0, _best: d.plays || 0 });
    } else {
      prev.plays += (d.plays || 0);
      if ((d.plays || 0) > prev._best) { prev._best = d.plays || 0; prev.artist = d.artist; prev.track = d.track; prev.album = d.album; }
    }
  });
  const newTrackCounts = {};
  ltDedup.forEach((v, k) => { newTrackCounts[k] = { artist: v.artist, track: v.track, album: v.album, plays: v.plays }; });
  _lastfmTrackCounts = newTrackCounts;
  const removedTracks = beforeTracks - Object.keys(_lastfmTrackCounts).length;

  invalidateCache();
  renderMissing();
  if (typeof renderMissingTracks === 'function') renderMissingTracks();
  updateNavBadges();
  saveToStorage();

  if (!window._sb) {
    toast(`✓ Nettoyé localement : ${removedAlbums} doublon(s) albums, ${removedTracks} doublon(s) morceaux fusionnés`);
    return;
  }

  toast(`Nettoyage Supabase en cours… (${removedAlbums} albums, ${removedTracks} morceaux détectés)`);
  try {
    // Remplacement complet : purge la table puis réinsère la version fusionnée,
    // sinon les anciennes lignes en double (autre casse) restent orphelines côté serveur.
    await window._sb.from('lastfm_data').delete().neq('artist', '___never___');
    if (lastfmData.length) {
      await sbUpsert('lastfm_data', lastfmData.map(d => ({ artist: d.artist, album: d.album, plays: d.plays || 0 })), 'artist,album');
    }
    if (Object.keys(_lastfmTrackCounts).length) {
      await window._sb.from('lastfm_tracks').delete().neq('artist', '___never___');
      const trackRows = Object.values(_lastfmTrackCounts).map(d => ({ artist: d.artist, track: d.track, album: d.album || '', plays: d.plays || 0 }));
      for (let i = 0; i < trackRows.length; i += 400) {
        await window._sb.from('lastfm_tracks').upsert(trackRows.slice(i, i + 400), { onConflict: 'artist,track,album' });
      }
    }
    toast(`✓ last.fm nettoyé : ${removedAlbums} doublon(s) albums, ${removedTracks} doublon(s) morceaux fusionnés`);
  } catch (e) {
    toast('Erreur nettoyage Supabase : ' + (e.message || e), 'error');
  }
}

// ===================== RESET COMPLET LAST.FM (Supabase + local) =====================
// cleanupLastfmDuplicates() ci-dessus ne fusionne que les entrées qui diffèrent par la CLÉ
// (casse/ponctuation) — il ne peut rien pour une entrée dont le compteur .plays est déjà gonflé
// À L'INTÉRIEUR d'une même clé (ex: ancien bug ListenBrainz corrigé en v2026.07.08-04, ou tout
// autre résidu antérieur). Une resync classique (↺ Resync) recalcule bien un total correct en
// mémoire, mais l'upsert Supabase (onConflict artist,track,album) n'écrase que les lignes dont la
// clé correspond exactement — une éventuelle ligne orpheline d'une variante de clé antérieure (ex:
// casse différente du tag album selon la source) reste en base et se rajoute au total affiché à la
// prochaine consolidation par (artiste, titre). Seule une purge complète des tables AVANT resync
// garantit un état propre, quelle que soit l'origine du résidu.
async function resetLastfmCompletely() {
  if (!confirm('Ceci va effacer TOUTES les données last.fm (albums + morceaux) côté Supabase et en local, puis repartir de zéro.\n\nÀ utiliser si des écoutes restent doublées malgré une resync classique (résidu d\'un bug déjà corrigé, ou de duplication de lignes en base).\n\nAprès la purge, relance manuellement "Sync last.fm" pour tout recharger depuis l\'API — ça peut prendre du temps selon la taille de ton historique.\n\nContinuer ?')) return;
  closeIntegrityModal();
  const status = document.getElementById('status-lastfm');
  if (status) { status.textContent = 'Purge complète last.fm en cours…'; status.className = 'status'; }
  try {
    if (window._sb) {
      await window._sb.from('lastfm_data').delete().neq('artist', '___never___');
      await window._sb.from('lastfm_tracks').delete().neq('artist', '___never___');
      await window._sb.from('meta').delete().in('key', ['lastfm_sync_ts', 'lb_sync_ts']);
    }
    lastfmData = [];
    _lastfmCounts = {};
    _lastfmTrackCounts = {};
    albums.forEach(a => { a.plays = 0; });
    localStorage.removeItem(LASTFM_SYNC_KEY);
    localStorage.removeItem(LB_SYNC_KEY);
    clearLastfmCheckpoint();
    localStorage.removeItem('lb_checkpoint');
    invalidateCache();
    renderAlbums();
    updateNavBadges();
    saveToStorage();
    if (status) { status.textContent = '✓ Purgé — clique "Sync last.fm" pour tout recharger depuis zéro.'; status.className = 'status ok'; }
    toast('✓ last.fm entièrement purgé — relance "Sync last.fm" pour repartir de zéro');
  } catch(e) {
    if (status) { status.textContent = 'Erreur purge : ' + (e.message || e); status.className = 'status err'; }
    toast('Erreur purge last.fm : ' + (e.message || e), 'error');
  }
}

async function initApp() {
  loadLastfmTrackStatus();
  loadLovedTracks();
  const restored = loadFromStorage();
  // Ne charger la démo que si pas de Supabase et pas de données locales
  if (!restored && !window._sb) {
    loadDemo();
    saveToStorage();
  }
  _dataReady = true;
  // Migration ponctuelle : déplacer vers la wishlist morceaux les entrées "album"
  // qui sont en fait des singles (tag Album == titre du morceau) ajoutées par erreur.
  const migrated = migrateTrackLikeWishlistEntries();
  if (migrated) toast(`${migrated} entrée${migrated>1?'s':''} de la wishlist déplacée${migrated>1?'s':''} vers les morceaux ✓`);
  const cleanedCorrupted = cleanupCorruptedWishlistEntries();
  if (cleanedCorrupted) toast(`${cleanedCorrupted} entrée${cleanedCorrupted>1?'s':''} corrompue${cleanedCorrupted>1?'s':''} ("[object Object]") retirée${cleanedCorrupted>1?'s':''} de la wishlist ✓`);
  pruneWishlistOwned();
  // Restaurer config last.fm et reconnecter automatiquement
  const lfmCfg = localStorage.getItem('lastfm_cfg');
  if (lfmCfg) {
    try {
      const { apiKey, user } = JSON.parse(lfmCfg);
      const el1 = document.getElementById('lastfm-apikey');
      const el2 = document.getElementById('lastfm-user');
      if (el1) el1.value = apiKey;
      if (el2) el2.value = user;
      _lastfmApiKey = apiKey;
      _lastfmUser = user;
    } catch(e) {}
  } else {
    // Config par défaut intégrée : lancer la synchro auto silencieusement (via autoSyncLastfm)
    setTimeout(() => autoSyncLastfm(), 2000);
  }
  // Vérifier si un checkpoint last.fm existe
  const cp = loadLastfmCheckpoint();
  if (cp) {
    const status = document.getElementById('status-lastfm');
    const btnMore = document.getElementById('btn-lastfm-more');
    if (status) {
      status.textContent = `⏸ Chargement interrompu à la page ${cp.page}/${cp.totalPages} — ${cp.counts?.length || 0} albums — cliquez Reprendre`;
      status.className = 'status ok';
    }
    if (btnMore) {
      btnMore.textContent = '▶ Reprendre';
      btnMore.style.display = 'inline-flex';
      _lastfmAbort = true;
      _lastfmTotalPages = cp.totalPages;
      _lastfmCurrentPage = cp.page;
    }
  }
  // Afficher date dernière sync
  updateLastSyncLabel();
  renderAlbums();
  renderTracks();
  updateNavBadges();
}

// Restaurer token Discogs (valeur par défaut si absent)
(function() {
  const DEFAULT_DISCOGS_TOKEN = 'qlBzWMRIfyKQXysUTObLlPWRSZjFvrcjjyRnmFTC';
  const t = localStorage.getItem('discogs_token') || DEFAULT_DISCOGS_TOKEN;
  if (!localStorage.getItem('discogs_token')) localStorage.setItem('discogs_token', DEFAULT_DISCOGS_TOKEN);
  const el = document.getElementById('discogs-token');
  if (el) el.value = t;
})();

(async function startup() {
  const savedCfg = localStorage.getItem(LS_CFG);
  const savedKey = localStorage.getItem(LS_ANON_KEY);

  if (savedCfg === 'supabase' && savedKey) {
    // Reconnexion automatique — en cas d'échec réseau, mode local sans re-demander la clé
    try {
      const ok = await connectSupabase(savedKey);
      if (!ok) {
        // Clé rejetée par Supabase → la supprimer et re-demander
        localStorage.removeItem(LS_ANON_KEY);
        localStorage.removeItem(LS_CFG);
        loadDemo();
        document.getElementById('supabase-setup').style.display = 'flex';
      }
    } catch(e) {
      // Erreur réseau / timeout → continuer en mode local avec les données en cache
      console.warn('Supabase indisponible au démarrage, mode local :', e);
      await initApp();
    }
  } else if (savedCfg === 'skip') {
    await initApp();
  } else {
    // Première ouverture : charger démo et montrer l'écran de config
    loadDemo();
    document.getElementById('supabase-setup').style.display = 'flex';
  }
})();

// ===================== DEBOUNCE DES INPUTS TEXTE =====================
// Appliqué après le chargement du DOM — remplace les oninput inline
// pour toutes les fonctions de rendu coûteuses (300ms par défaut, 150ms pour les légères)
document.addEventListener('DOMContentLoaded', () => {
  renderAllFilterPresetOptions();
  const rules = [
    // [id de l'input, fonction à appeler, délai ms]
    ['global-search',        () => onSearch(),                           200],
    ['filter-artist',        () => { currentPage = 1; renderAlbums(); }, 300],
    ['filter-album',         () => { currentPage = 1; renderAlbums(); }, 300],
    ['filter-track-artist',  () => renderTracks(),                       300],
    ['filter-track-title',   () => renderTracks(),                       300],
    ['filter-track-album',   () => renderTracks(),                       300],
    ['filter-missing-artist',() => renderMissing(),                      300],
    ['filter-missing-album', () => renderMissing(),                      300],
    ['filter-mtrack-artist', () => renderMissingTracks(),                300],
    ['filter-mtrack-title',  () => renderMissingTracks(),                300],
    ['filter-mtrack-album',  () => renderMissingTracks(),                300],
    ['filter-wish-artist',   () => renderWishlist(),                     200],
    ['filter-wish-album',    () => renderWishlist(),                     200],
    ['filter-assoc-q',       () => renderAssocReview(),                  200],
    ['filter-ok-artist',     () => renderOkAlbums(),                     200],
    ['filter-forsale-artist',() => renderForSale(),                      200],
    ['filter-at-artist',     () => renderAllTracks(),                    300],
    ['filter-at-title',      () => renderAllTracks(),                    300],
    ['filter-at-album',      () => renderAllTracks(),                    300],
    ['filter-abt-artist',    () => renderAlbumTracks(),                  300],
    ['filter-abt-title',     () => renderAlbumTracks(),                  300],
    ['filter-abt-album',     () => renderAlbumTracks(),                  300],
    ['filter-tw-artist',     () => renderTrackWishlist(),                200],
    ['filter-tw-title',      () => renderTrackWishlist(),                200],
    ['filter-year',          () => { currentPage = 1; renderAlbums(); }, 300],
    ['filter-ok-year',       () => renderOkAlbums(),                     300],
    ['filter-forsale-year',  () => renderForSale(),                      300],
    ['filter-wish-year',     () => renderWishlist(),                     300],
    ['filter-missing-year',  () => renderMissing(),                      300],
    ['filter-disco-artist',  () => renderDiscographie(),                  300],
    ['filter-disco-album',   () => renderDiscographie(),                  300],
    ['filter-ok-album',      () => renderOkAlbums(),                     300],
  ];
	rules.forEach(([id, fn, delay]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.removeAttribute('oninput');
    el.addEventListener('input', debounce(fn, delay));
  });

  // Délégation d'événements pour missing-grid (évite les onclick inline)
  document.getElementById('missing-grid').addEventListener('click', function(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const idx    = parseInt(btn.dataset.idx);
    const action = btn.dataset.action;
    if (action === 'assoc')          associateFromMissingIdx(idx);
    else if (action === 'wishlist')  setLastfmStatusWishlist(idx);
    else if (action === 'youtube')   { const m = _missingListCache[idx]; if(m) openYouTubeMusicSearch(m.artist, m.album); }
    else                             setLastfmStatusFromMissing(idx, action);
  });
});

// ===================== DIAGNOSTIC D'INTÉGRITÉ =====================
// Ne couvre QUE les incohérences qui n'ont pas déjà d'outil dédié ailleurs, pour éviter les
// doublons de menu :
//   - doublons d'albums (id ou variantes proches)   → déjà couverts par 🔧 Fusionner les
//     doublons (deduplicateAlbums) et 🔍 Détecter les doublons potentiels (dup finder)
//   - associations CD↔numérique / RYM orphelines    → déjà couverts par l'onglet
//     Associations, filtre "⚠️ Introuvables" (renderAssocReview)
//   - wishlist corrompue ([object Object], champs vides) → déjà nettoyée automatiquement
//     au chargement (cleanupCorruptedWishlistEntries, appelée dans initApp)
// Cet outil ne fait donc que : (1) pointer vers ces outils existants en un clic, et
// (2) détecter les quelques incohérences qui n'ont sinon aucun autre point d'entrée.
const INTEGRITY_LOG_KEY = 'discotheque_integrity_log';
const INTEGRITY_LOG_MAX = 15; // limite le volume stocké en localStorage (snapshots complets)
let integrityLog = [];

function loadIntegrityLog() {
  try { integrityLog = JSON.parse(localStorage.getItem(INTEGRITY_LOG_KEY) || '[]'); }
  catch(e) { integrityLog = []; }
}
loadIntegrityLog();

function saveIntegrityLog() {
  integrityLog = integrityLog.slice(-INTEGRITY_LOG_MAX);
  try { localStorage.setItem(INTEGRITY_LOG_KEY, JSON.stringify(integrityLog)); }
  catch(e) { console.warn('Historique intégrité : écriture localStorage échouée (quota ?)', e); }
}

// Snapshot pris AVANT chaque correction automatique, pour pouvoir l'annuler ensuite.
// Ne couvre que les tableaux effectivement modifiés par les fixes de cet outil
// (albums, tracks, wishlist) — pas lastfmData/rymData, jamais touchés ici.
function snapshotForUndo(label) {
  integrityLog.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts: Date.now(),
    label,
    snapshot: {
      albums:   JSON.parse(JSON.stringify(albums)),
      tracks:   JSON.parse(JSON.stringify(tracks)),
      wishlist: JSON.parse(JSON.stringify(wishlist)),
    }
  });
  saveIntegrityLog();
}

function undoIntegrityFix(id) {
  const idx = integrityLog.findIndex(e => e.id === id);
  if (idx === -1) return;
  const entry = integrityLog[idx];
  if (!confirm(`Annuler la correction « ${entry.label} » du ${new Date(entry.ts).toLocaleString('fr-FR')} et restaurer l'état d'avant ?\n\nLes corrections plus récentes que celle-ci seront aussi retirées de l'historique.`)) return;
  albums   = entry.snapshot.albums;
  tracks   = entry.snapshot.tracks;
  wishlist = entry.snapshot.wishlist;
  // L'historique après ce point n'a plus de sens (il partait d'un état qu'on vient d'écraser)
  integrityLog = integrityLog.slice(0, idx);
  saveIntegrityLog();
  invalidateCache();
  renderAlbums(); renderTracks(); updateNavBadges(); saveToStorage();
  toast('Correction annulée, état restauré ✓');
  renderIntegrityList();
}

function computeIntegrityReport() {
  const issues = [];

  // Wishlist : doublons internes (même artiste+album en double dans la wishlist)
  {
    const byKey = new Map();
    wishlist.forEach(w => {
      const k = normalizeKey(w.artist, w.album);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(w);
    });
    const dupGroups = [...byKey.values()].filter(g => g.length > 1);
    if (dupGroups.length) {
      issues.push({
        key: 'wishlist_dup', severity: 'avertissement',
        label: `${dupGroups.length} doublon(s) dans la wishlist`,
        detail: "Le même artiste + album apparaît plusieurs fois dans la wishlist.",
        sample: dupGroups.slice(0, 5).map(g => `${g[0].artist} — ${g[0].album} (×${g.length})`),
        fix: 'fixWishlistDup'
      });
    }
  }

  // Wishlist : entrées dont le CD est déjà possédé (Discogs) — la wishlist vise l'acquisition
  // d'un CD manquant, donc seule la possession du CD rend l'entrée obsolète. La possession
  // en numérique seul ne compte PAS (c'est justement le cas d'usage "Ok" : numérique déjà là,
  // CD encore souhaité), donc on ne la signale jamais sur ce critère.
  {
    const ownedCdKeys = new Set(
      albums.filter(a => a.cd || a.has_cd).map(a => normalizeKey(a.artist, a.album))
    );
    const alreadyOnCd = wishlist.filter(w => ownedCdKeys.has(normalizeKey(w.artist, w.album)));
    if (alreadyOnCd.length) {
      issues.push({
        key: 'wishlist_cd_owned', severity: 'avertissement',
        label: `${alreadyOnCd.length} entrée(s) wishlist dont le CD est déjà possédé`,
        detail: "Le CD est déjà présent dans la collection (Discogs) — cette entrée wishlist n'a plus lieu d'être, contrairement à une simple possession numérique qui elle reste valide.",
        sample: alreadyOnCd.slice(0, 5).map(w => `${w.artist} — ${w.album}`),
        fix: 'fixWishlistCdOwned'
      });
    }
  }

  // Albums sans folders (jamais censé arriver — tout le rendu par onglet s'appuie dessus)
  {
    const empty = albums.filter(a => !a.folders || !a.folders.length);
    if (empty.length) {
      issues.push({
        key: 'empty_folders', severity: 'critique',
        label: `${empty.length} album(s) sans dossier (folders vide)`,
        detail: "Un album sans folders[] peut disparaître silencieusement de toutes les vues filtrées par dossier.",
        sample: empty.slice(0, 5).map(a => `${a.artist} — ${a.album}`),
        fix: 'fixEmptyFolders'
      });
    }
  }

  // Morceaux isolés incomplets (artiste ou titre vide)
  {
    const bad = tracks.filter(t => !t.artist?.trim() || !t.title?.trim());
    if (bad.length) {
      issues.push({
        key: 'bad_tracks', severity: 'avertissement',
        label: `${bad.length} morceau(x) isolé(s) incomplet(s)`,
        detail: "Artiste ou titre manquant — probablement issu d'un tag XML mal renseigné.",
        sample: bad.slice(0, 5).map(t => `${t.artist || '?'} — ${t.title || '?'}`),
        fix: 'fixBadTracks'
      });
    }
  }

  // Notes hors plage 0–5 sur albums ou morceaux (ex: échelle /10 importée telle quelle)
  {
    const isBadNote = n => n !== undefined && n !== null && n !== 0 && (isNaN(n) || n < 0 || n > 5);
    const badAlbums = albums.filter(a => isBadNote(a.note));
    const badTracks = tracks.filter(t => isBadNote(t.note));
    const total = badAlbums.length + badTracks.length;
    if (total) {
      issues.push({
        key: 'bad_notes', severity: 'avertissement',
        label: `${total} note(s) hors plage (0–5)`,
        detail: "Provient probablement d'une échelle mal convertie (ex: note /10 ou /100 importée telle quelle).",
        sample: [...badAlbums, ...badTracks].slice(0, 5).map(x => `${x.artist} — ${x.album || x.title} : ${x.note}`),
        fix: 'fixBadNotes'
      });
    }
  }

  return issues;
}

function openIntegrityModal() {
  renderIntegrityList();
  document.getElementById('modal-integrity').classList.add('open');
}

function closeIntegrityModal() {
  document.getElementById('modal-integrity').classList.remove('open');
}

document.getElementById('modal-integrity').addEventListener('click', function(e) {
  if (e.target === this) closeIntegrityModal();
});

document.getElementById('modal-cover-choice').addEventListener('click', function(e) {
  if (e.target === this) closeCoverChoiceModal();
});

const INTEGRITY_SEVERITY_COLOR = { critique: 'var(--red, #e5484d)', avertissement: 'var(--amber)', info: 'var(--text3)' };
const INTEGRITY_SEVERITY_ICON  = { critique: '🔴', avertissement: '🟡', info: 'ℹ️' };

function renderIntegrityList() {
  const issues = computeIntegrityReport();
  const counter = document.getElementById('integrity-counter');
  const nCrit = issues.filter(i => i.severity === 'critique').length;
  const nWarn = issues.filter(i => i.severity === 'avertissement').length;
  const nInfo = issues.filter(i => i.severity === 'info').length;
  counter.textContent = issues.length
    ? `${nCrit} critique(s) · ${nWarn} avertissement(s) · ${nInfo} info` : '';

  const el = document.getElementById('integrity-list');
  const issuesHtml = !issues.length
    ? '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Aucune incohérence détectée !</div>'
    : issues.map(issue => {
        const color = INTEGRITY_SEVERITY_COLOR[issue.severity];
        const icon  = INTEGRITY_SEVERITY_ICON[issue.severity];
        const sampleHtml = (issue.sample || []).map(s => `<div style="font-size:11px;color:var(--text2);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">• ${esc(s)}</div>`).join('');
        const actionBtn = issue.fix ? `<button class="btn btn-sm btn-accent" onclick="${issue.fix}()">🔧 Corriger automatiquement</button>` : '';
        return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px">
        <div>
          <span style="font-size:13px;font-weight:500">${icon} ${esc(issue.label)}</span>
          <div style="font-size:11px;color:${color};margin-top:2px">${issue.severity}</div>
        </div>
        ${actionBtn}
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:6px">${esc(issue.detail)}</div>
      ${sampleHtml}
    </div>`;
      }).join('');

  const historyHtml = !integrityLog.length ? '' : `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Historique des corrections (annulable)</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${integrityLog.slice().reverse().map(e => `
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text2);background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px">
            <span>${new Date(e.ts).toLocaleString('fr-FR')} — ${esc(e.label)}</span>
            <button class="btn btn-sm" onclick="undoIntegrityFix('${e.id}')">↩ Annuler</button>
          </div>`).join('')}
      </div>
    </div>`;

  el.innerHTML = issuesHtml + historyHtml;
}

// ── Corrections automatiques (avec snapshot pour annulation) ──

function fixWishlistDup() {
  snapshotForUndo('Doublons wishlist fusionnés');
  const seen = new Set();
  const before = wishlist.length;
  wishlist = wishlist.filter(w => {
    const k = normalizeKey(w.artist, w.album);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  saveToStorage();
  toast(`${before - wishlist.length} doublon(s) wishlist supprimé(s) ✓`);
  renderIntegrityList();
}

function fixWishlistCdOwned() {
  snapshotForUndo('Entrées wishlist retirées (CD déjà possédé)');
  const ownedCdKeys = new Set(
    albums.filter(a => a.cd || a.has_cd).map(a => normalizeKey(a.artist, a.album))
  );
  const before = wishlist.length;
  wishlist = wishlist.filter(w => !ownedCdKeys.has(normalizeKey(w.artist, w.album)));
  saveToStorage();
  toast(`${before - wishlist.length} entrée(s) wishlist retirée(s) (CD déjà possédé) ✓`);
  renderIntegrityList();
}

function fixEmptyFolders() {
  snapshotForUndo('Dossiers vides recatégorisés');
  let fixed = 0;
  albums.forEach(a => { if (!a.folders || !a.folders.length) { a.folders = ['album']; fixed++; } });
  invalidateCache();
  renderAlbums(); updateNavBadges(); saveToStorage();
  toast(`${fixed} album(s) recatégorisé(s) ✓`);
  renderIntegrityList();
}

function fixBadTracks() {
  snapshotForUndo('Morceaux incomplets supprimés');
  const before = tracks.length;
  tracks = tracks.filter(t => t.artist?.trim() && t.title?.trim());
  renderTracks(); updateNavBadges(); saveToStorage();
  toast(`${before - tracks.length} morceau(x) incomplet(s) supprimé(s) ✓`);
  renderIntegrityList();
}

function fixBadNotes() {
  snapshotForUndo('Notes hors plage réinitialisées');
  const isBadNote = n => n !== undefined && n !== null && n !== 0 && (isNaN(n) || n < 0 || n > 5);
  let fixed = 0;
  albums.forEach(a => { if (isBadNote(a.note)) { a.note = 0; fixed++; } });
  tracks.forEach(t => { if (isBadNote(t.note)) { t.note = 0; fixed++; } });
  renderAlbums(); renderTracks(); saveToStorage();
  toast(`${fixed} note(s) réinitialisée(s) ✓`);
  renderIntegrityList();
}

// ===================== NETTOYAGE DE TAXONOMIE GENRE =====================
// Todo section 11 : « détection de variantes proches (casse, espaces, quasi-doublons) avec
// fusion assistée — dans l'esprit du diagnostic d'intégrité existant ». Contrairement au
// diagnostic d'intégrité (corrections automatiques sans ambiguïté), une fusion de genre est
// un jugement humain (est-ce que "Rock alternatif" et "Rock Alternative" sont vraiment la
// même chose ?) — donc suggestions groupées avec choix du libellé canonique, jamais de fusion
// automatique. Réutilise snapshotForUndo()/integrityLog (même historique annulable que le
// diagnostic d'intégrité) plutôt qu'un système d'annulation dédié.

// Distance d'édition (Levenshtein) — implémentation compacte, une seule ligne de la matrice
// gardée en mémoire à la fois (suffisant pour des libellés de genre, jamais très longs).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Normalisation "légère" (casse/espaces) : deux genres qui ne diffèrent QUE par ça sont
// toujours la même entrée, fusion sans ambiguïté possible.
function normGenreLoose(g) {
  return (g || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
// Normalisation "serrée" (ponctuation en plus) : sert uniquement à repérer des candidats à la
// distance d'édition, jamais à décider seule (ex. "Hip Hop" / "Hip-Hop" / "HipHop").
function normGenreTight(g) {
  return normGenreLoose(g).replace(/[-_&,\/+.]+/g, ' ').replace(/\s+/g, '');
}

// Regroupe les genres distincts de la collection en clusters de variantes probables
// (union-find simple — le volume de genres distincts reste toujours assez faible, O(n²)
// largement suffisant, pas besoin d'un index plus malin).
function computeGenreClusters() {
  const counts = new Map(); // genre brut → nb d'albums
  albums.forEach(a => {
    if (!a.genre) return;
    counts.set(a.genre, (counts.get(a.genre) || 0) + 1);
  });
  const genres = [...counts.keys()];
  const parent = genres.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  for (let i = 0; i < genres.length; i++) {
    for (let j = i + 1; j < genres.length; j++) {
      const looseI = normGenreLoose(genres[i]), looseJ = normGenreLoose(genres[j]);
      if (looseI === looseJ) { union(i, j); continue; } // casse/espaces — fusion évidente
      const tightI = normGenreTight(genres[i]), tightJ = normGenreTight(genres[j]);
      if (tightI === tightJ) { union(i, j); continue; } // ponctuation seule (Hip Hop / Hip-Hop)
      // Quasi-doublon : distance d'édition tolérée proportionnelle à la longueur, et seulement
      // au-delà de 4 caractères pour éviter de rapprocher des genres courts sans rapport
      // ("Pop" / "Pop" mis à part, "IDM"/"EDM" ne doivent PAS fusionner : 3 caractères, distance 1
      // mais ce sont deux genres différents — d'où le seuil de longueur).
      if (Math.min(tightI.length, tightJ.length) >= 5) {
        const maxDist = Math.min(tightI.length, tightJ.length) >= 10 ? 2 : 1;
        if (levenshtein(tightI, tightJ) <= maxDist) union(i, j);
      }
    }
  }

  const clusters = new Map(); // racine → [genres bruts]
  genres.forEach((g, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(g);
  });

  return [...clusters.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      variants: group
        .map(g => ({ genre: g, count: counts.get(g) }))
        .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, 'fr')),
    }))
    .sort((a, b) => b.variants.reduce((s, v) => s + v.count, 0) - a.variants.reduce((s, v) => s + v.count, 0));
}

let _genreClustersDismissed = new Set(); // session seulement — clé = variantes triées jointes

function openGenreCleanupModal() {
  _genreClustersDismissed = new Set();
  renderGenreCleanup();
  document.getElementById('modal-genre-cleanup').classList.add('open');
}
function closeGenreCleanupModal() {
  document.getElementById('modal-genre-cleanup').classList.remove('open');
}
document.getElementById('modal-genre-cleanup').addEventListener('click', function(e) {
  if (e.target === this) closeGenreCleanupModal();
});

function _clusterKey(variants) { return variants.map(v => v.genre).sort().join('|||'); }

function renderGenreCleanup() {
  const clusters = computeGenreClusters().filter(c => !_genreClustersDismissed.has(_clusterKey(c.variants)));
  const counter = document.getElementById('genre-cleanup-counter');
  if (counter) counter.textContent = clusters.length ? `${clusters.length} groupe(s) de variantes probables` : '';

  const el = document.getElementById('genre-cleanup-list');
  if (!clusters.length) {
    el.innerHTML = '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Aucune variante de genre détectée.</div>';
    return;
  }
  el.innerHTML = clusters.map((c, ci) => {
    const key = _clusterKey(c.variants);
    const total = c.variants.reduce((s, v) => s + v.count, 0);
    const radios = c.variants.map((v, vi) => `
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
        <input type="radio" name="genre-canon-${ci}" value="${escAttr(v.genre)}" ${vi === 0 ? 'checked' : ''}>
        <span style="font-family:var(--mono)">${esc(v.genre)}</span>
        <span style="color:var(--text3);font-size:11px">(${v.count} album${v.count > 1 ? 's' : ''})</span>
      </label>`).join('');
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px" data-cluster-key="${escAttr(key)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px">
        <span style="font-size:13px;font-weight:500">${c.variants.length} variantes · ${total} album(s) au total</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-accent" onclick="mergeGenreCluster(${ci}, '${escAttr(key)}')">🔧 Fusionner vers le choix ci-dessous</button>
          <button class="btn btn-sm" onclick="dismissGenreCluster('${escAttr(key)}')" title="Ignorer pour cette session — ce ne sont pas de vrais doublons">✕ Ignorer</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column">${radios}</div>
    </div>`;
  }).join('');
}

function dismissGenreCluster(key) {
  _genreClustersDismissed.add(key);
  renderGenreCleanup();
}

function mergeGenreCluster(clusterIndex, key) {
  const clusters = computeGenreClusters().filter(c => !_genreClustersDismissed.has(_clusterKey(c.variants)));
  const cluster = clusters.find(c => _clusterKey(c.variants) === key);
  if (!cluster) return;
  const selected = document.querySelector(`input[name="genre-canon-${clusterIndex}"]:checked`);
  const canon = selected ? selected.value : cluster.variants[0].genre;
  const variantGenres = new Set(cluster.variants.map(v => v.genre));
  variantGenres.delete(canon);
  if (!variantGenres.size) { toast('Rien à fusionner (déjà uniforme)', 'warn'); return; }

  snapshotForUndo(`Genres fusionnés vers "${canon}" (${[...variantGenres].join(', ')})`);
  // Toutes les valeurs du groupe (variantes + canon lui-même) — sert à verrouiller aussi les
  // albums déjà sur la valeur canonique, pas seulement ceux qu'on vient de changer.
  const allClusterGenres = new Set(cluster.variants.map(v => v.genre));
  let fixed = 0, locked = 0;
  albums.forEach(a => {
    if (!a.genre || !allClusterGenres.has(a.genre)) return;
    if (a.genre !== canon) { a.genre = canon; fixed++; }
    // Verrouille pour que ça tienne face au prochain réimport MusicBee (v2026.07.12-14,
    // demandé par Antoine — n'étant pas maître de la donnée MusicBee, une fusion non
    // verrouillée était silencieusement annulée dès que MusicBee réexportait l'ancien tag).
    if (!isManualField(a, 'genre')) { setProvenance(a, 'genre', 'manual'); locked++; }
  });
  invalidateCache();
  saveToStorage();
  updateNavBadges();
  toast(`${fixed} album(s) reclassé(s) et ${locked} verrouillé(s) vers "${canon}" ✓`);
  renderGenreCleanup();
}

// ===================== NETTOYAGE DE TAXONOMIE ARTISTE =====================
// Todo section 1, item ⬜ « même mécanisme que le nettoyage de genres, appliqué à
// album.artist — des variantes comme "The Beatles"/"Beatles, The"/"Beatles" fragmentent
// silencieusement les stats et filtres par artiste ». Même moule que le nettoyage de genre
// (union-find, jamais de fusion automatique) + une 3e normalisation dédiée au cas d'inversion
// d'article ("X, The" / "The X") qui est la variante la plus fréquente pour les artistes et
// n'a pas d'équivalent côté genre. Volontairement scope = album.artist uniquement (comme
// demandé) — tracks[]/wishlist[] portent aussi un champ artist mais ne sont pas couverts ici,
// même choix de périmètre que le nettoyage de genre qui ne touche que album.genre.
function normArtistLoose(a) {
  return (a || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normArtistTight(a) {
  return normArtistLoose(a).replace(/[-_&,\/+.'’]+/g, ' ').replace(/\s+/g, '');
}
// Résout l'inversion d'article ("Beatles, The" ↔ "The Beatles") en ramenant les deux formes
// à un même "cœur" : article en tête retiré, virgule+article en fin repositionné en tête.
function normArtistCore(a) {
  let s = normArtistLoose(a);
  const trailing = s.match(/^(.*),\s*(the|a|an)$/i);
  if (trailing) s = `${trailing[2]} ${trailing[1]}`.trim();
  return s.replace(/^(the|a|an)\s+/i, '').trim();
}

function computeArtistClusters() {
  const counts = new Map(); // artiste brut → nb d'albums
  albums.forEach(a => {
    if (!a.artist) return;
    counts.set(a.artist, (counts.get(a.artist) || 0) + 1);
  });
  const artists = [...counts.keys()];
  const parent = artists.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  for (let i = 0; i < artists.length; i++) {
    for (let j = i + 1; j < artists.length; j++) {
      const looseI = normArtistLoose(artists[i]), looseJ = normArtistLoose(artists[j]);
      if (looseI === looseJ) { union(i, j); continue; } // casse/espaces
      const coreI = normArtistCore(artists[i]), coreJ = normArtistCore(artists[j]);
      if (coreI === coreJ) { union(i, j); continue; } // inversion d'article "X, The" / "The X"
      const tightI = normArtistTight(artists[i]), tightJ = normArtistTight(artists[j]);
      if (tightI === tightJ) { union(i, j); continue; } // ponctuation seule
      // Quasi-doublon : distance d'édition tolérée, seuil de longueur plus élevé que pour les
      // genres (noms d'artiste souvent plus longs, et les faux positifs entre 2 artistes
      // réellement différents coûtent plus cher qu'en genre).
      if (Math.min(tightI.length, tightJ.length) >= 6) {
        const maxDist = Math.min(tightI.length, tightJ.length) >= 12 ? 2 : 1;
        if (levenshtein(tightI, tightJ) <= maxDist) union(i, j);
      }
    }
  }

  const clusters = new Map();
  artists.forEach((a, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(a);
  });

  return [...clusters.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      variants: group
        .map(a => ({ artist: a, count: counts.get(a) }))
        .sort((a, b) => b.count - a.count || a.artist.localeCompare(b.artist, 'fr')),
    }))
    .sort((a, b) => b.variants.reduce((s, v) => s + v.count, 0) - a.variants.reduce((s, v) => s + v.count, 0));
}

let _artistClustersDismissed = new Set(); // session seulement

function openArtistCleanupModal() {
  _artistClustersDismissed = new Set();
  renderArtistCleanup();
  document.getElementById('modal-artist-cleanup').classList.add('open');
}
function closeArtistCleanupModal() {
  document.getElementById('modal-artist-cleanup').classList.remove('open');
}
document.getElementById('modal-artist-cleanup').addEventListener('click', function(e) {
  if (e.target === this) closeArtistCleanupModal();
});

function _artistClusterKey(variants) { return variants.map(v => v.artist).sort().join('|||'); }

function renderArtistCleanup() {
  const clusters = computeArtistClusters().filter(c => !_artistClustersDismissed.has(_artistClusterKey(c.variants)));
  const counter = document.getElementById('artist-cleanup-counter');
  if (counter) counter.textContent = clusters.length ? `${clusters.length} groupe(s) de variantes probables` : '';

  const el = document.getElementById('artist-cleanup-list');
  if (!clusters.length) {
    el.innerHTML = '<div class="empty" style="padding:24px"><div class="empty-icon">✅</div>Aucune variante d\'artiste détectée.</div>';
    return;
  }
  el.innerHTML = clusters.map((c, ci) => {
    const key = _artistClusterKey(c.variants);
    const total = c.variants.reduce((s, v) => s + v.count, 0);
    const radios = c.variants.map((v, vi) => `
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer">
        <input type="radio" name="artist-canon-${ci}" value="${escAttr(v.artist)}" ${vi === 0 ? 'checked' : ''}>
        <span style="font-family:var(--mono)">${esc(v.artist)}</span>
        <span style="color:var(--text3);font-size:11px">(${v.count} album${v.count > 1 ? 's' : ''})</span>
      </label>`).join('');
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px" data-cluster-key="${escAttr(key)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px">
        <span style="font-size:13px;font-weight:500">${c.variants.length} variantes · ${total} album(s) au total</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-accent" onclick="mergeArtistCluster(${ci}, '${escAttr(key)}')">🔧 Fusionner vers le choix ci-dessous</button>
          <button class="btn btn-sm" onclick="dismissArtistCluster('${escAttr(key)}')" title="Ignorer pour cette session — pas de vrais doublons (ex. collaboration distincte)">✕ Ignorer</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column">${radios}</div>
    </div>`;
  }).join('');
}

function dismissArtistCluster(key) {
  _artistClustersDismissed.add(key);
  renderArtistCleanup();
}

function mergeArtistCluster(clusterIndex, key) {
  const clusters = computeArtistClusters().filter(c => !_artistClustersDismissed.has(_artistClusterKey(c.variants)));
  const cluster = clusters.find(c => _artistClusterKey(c.variants) === key);
  if (!cluster) return;
  const selected = document.querySelector(`input[name="artist-canon-${clusterIndex}"]:checked`);
  const canon = selected ? selected.value : cluster.variants[0].artist;
  const variantArtists = new Set(cluster.variants.map(v => v.artist));
  variantArtists.delete(canon);
  if (!variantArtists.size) { toast('Rien à fusionner (déjà uniforme)', 'warn'); return; }

  snapshotForUndo(`Artistes fusionnés vers "${canon}" (${[...variantArtists].join(', ')})`);
  // Toutes les valeurs du groupe (variantes + canon lui-même) — sert à verrouiller aussi les
  // albums déjà sur la valeur canonique, pas seulement ceux qu'on vient de changer.
  const allClusterArtists = new Set(cluster.variants.map(v => v.artist));
  let fixed = 0, locked = 0;
  albums.forEach(a => {
    if (!a.artist || !allClusterArtists.has(a.artist)) return;
    if (a.artist !== canon) { a.artist = canon; fixed++; }
    // Verrouille pour que ça tienne face au prochain réimport MusicBee (v2026.07.12-14,
    // demandé par Antoine — même raison que pour le genre). Les albums avec discogsId étaient
    // déjà protégés (Discogs fait autorité sur l'artiste), le verrou protège maintenant aussi
    // les albums Stock/numériques purs qui n'ont pas cette protection.
    if (!isManualField(a, 'artist')) { setProvenance(a, 'artist', 'manual'); locked++; }
  });
  invalidateCache();
  saveToStorage();
  updateNavBadges();
  toast(`${fixed} album(s) reclassé(s) et ${locked} verrouillé(s) vers "${canon}" ✓`);
  renderArtistCleanup();
}


// Contrairement à l'historique du diagnostic d'intégrité (localStorage, portée limitée aux
// corrections automatiques de cet outil), ces snapshots couvrent TOUTE la collection et sont
// stockés côté Supabase — donc disponibles même après un rechargement ou depuis un autre
// appareil. Deux origines :
//  - manuel  : pris à la demande (bouton "📸 Créer un snapshot"), recommandé avant un gros
//              réimport XML/CSV ou une session de fusions.
//  - auto    : pris automatiquement juste avant que saveToSupabase() ne supprime un nombre
//              anormalement élevé d'albums côté Supabase — garde-fou si l'état local est
//              corrompu/vidé par erreur juste avant une synchronisation.
//
// Migration Supabase à exécuter une fois (SQL editor) :
//   create table if not exists collection_snapshots (
//     id bigserial primary key,
//     created_at timestamptz default now(),
//     label text,
//     data jsonb,
//     counts jsonb
//   );
// Si la table existe déjà (avant v2026.07.08-13) :
//   alter table collection_snapshots add column if not exists counts jsonb;
const SNAPSHOT_KEEP = 10;           // nombre de snapshots conservés (les plus anciens sont purgés)
const SNAPSHOT_AUTO_THRESHOLD = 5;  // déclenche un snapshot auto si une sync s'apprête à supprimer plus de X albums

// Convertit une ligne Supabase brute (snake_case) en album au format local (camelCase) —
// version allégée de la logique de loadFromSupabase, utilisée uniquement pour l'inspection/
// restauration d'un snapshot de sécurité automatique (pas besoin des heuristiques de
// migration historiques ici, seulement de récupérer les données fidèlement).
function _rowToLocalAlbum(a) {
  let folders = [];
  try { folders = JSON.parse(a.folders || '[]'); } catch(e) {}
  return {
    id: a.id, artist: a.artist, album: a.album, year: a.year || '', genre: a.genre || '',
    folders, has_cd: !!a.has_cd, format: a.format || '', note: a.note || 0, plays: a.plays || 0,
    notes: a.notes || '', discogsId: a.discogs_id || undefined, discogsRating: a.discogs_rating || undefined,
    mb_release_id: a.mb_release_id || undefined, cover_url: a.cover_url || undefined,
    lastfmAliases: a.lastfm_aliases ? JSON.parse(a.lastfm_aliases) : undefined,
    mergedAliases: a.merged_aliases ? JSON.parse(a.merged_aliases) : undefined,
    label: a.label || undefined, catno: a.catno || undefined, isCompilation: !!a.is_compilation,
    primaryFolder: a.primary_folder || 'album',
    cd: !!a.has_cd, flac: a.format === 'flac', mp3: a.format === 'mp3', digital: a.format === 'digital',
    okFolder: folders.includes('ok'), forSale: folders.includes('forsale'),
  };
}

// Résumé léger (compteurs) calculé au moment de la création — stocké dans une colonne à part
// (counts) pour que la liste des snapshots (renderSnapshotsList) n'ait jamais besoin de retélécharger
// la colonne `data` complète (tout le JSON de la collection) juste pour afficher "X albums · Y morceaux".
// BUG CORRIGÉ (v2026.07.08-13) : avant ce correctif, la modale "Snapshots Supabase" retéléchargeait
// l'intégralité des 10 snapshots conservés (SNAPSHOT_KEEP) à CHAQUE ouverture, uniquement pour ces
// compteurs — probable plus gros poste de l'egress Supabase observé (dépassement du quota gratuit).
function _snapshotCounts(payload) {
  const d = payload || {};
  if (d._remoteFormat) return { remoteFormat: true, albums: (d.albums || []).length };
  return {
    remoteFormat: false,
    albums: (d.albums || []).length,
    tracks: (d.tracks || []).length,
    wishlist: (d.wishlist || []).length,
  };
}

async function createSnapshot(label, payload) {
  if (!window._sb) { toast("Supabase non connecté — snapshot impossible", 'error'); return false; }
  try {
    const finalPayload = payload || { _remoteFormat: false, albums, tracks, associations, rymAssociations, wishlist, trackWishlist };
    const { error } = await window._sb.from('collection_snapshots').insert({
      label: label || 'Snapshot',
      data: finalPayload,
      counts: _snapshotCounts(finalPayload),
    });
    if (error) throw error;
    await pruneOldSnapshots();
    return true;
  } catch(e) {
    console.error('createSnapshot error', e);
    // Table probablement absente — message explicite plutôt qu'une erreur muette
    const msg = /relation .* does not exist|not found/i.test(e.message || '')
      ? "Table collection_snapshots absente — voir la migration SQL en commentaire du code"
      : (e.message || String(e));
    toast('Erreur snapshot : ' + msg, 'error');
    return false;
  }
}

async function pruneOldSnapshots() {
  try {
    const { data } = await window._sb.from('collection_snapshots')
      .select('id').order('created_at', { ascending: false });
    if (!data || data.length <= SNAPSHOT_KEEP) return;
    const toDelete = data.slice(SNAPSHOT_KEEP).map(r => r.id);
    if (toDelete.length) await window._sb.from('collection_snapshots').delete().in('id', toDelete);
  } catch(e) { console.warn('pruneOldSnapshots error', e); }
}

async function manualSnapshot() {
  const label = prompt('Nom du snapshot (optionnel) :', `Manuel — ${new Date().toLocaleString('fr-FR')}`);
  if (label === null) return; // annulé
  toast('Création du snapshot…');
  const ok = await createSnapshot(label, { _remoteFormat: false, albums, tracks, associations, rymAssociations, wishlist, trackWishlist });
  if (ok) toast('📸 Snapshot créé ✓');
}

// Snapshot de sécurité automatique — capture l'état REMOTE des albums (pas l'état local, qui
// est justement la cause du risque de purge massive) juste avant qu'une synchronisation ne
// supprime un nombre anormal de lignes côté Supabase.
async function autoSnapshotBeforeDelete(deleteCount) {
  if (deleteCount < SNAPSHOT_AUTO_THRESHOLD) return;
  console.warn(`[snapshot auto] ${deleteCount} suppression(s) Supabase détectée(s) — snapshot de sécurité avant purge`);
  try {
    let remoteAlbums = [], rp = 0;
    while (true) {
      const { data: batch } = await window._sb.from('albums').select('*').range(rp * 1000, (rp + 1) * 1000 - 1);
      if (!batch || !batch.length) break;
      remoteAlbums = remoteAlbums.concat(batch);
      if (batch.length < 1000) break; rp++;
    }
    await createSnapshot(`Auto — avant suppression de ${deleteCount} album(s)`, {
      _remoteFormat: true, albums: remoteAlbums, tracks: [], associations: [], rymAssociations: [], wishlist: [], trackWishlist: [],
    });
  } catch(e) { console.warn('autoSnapshotBeforeDelete error', e); }
}

async function openSnapshotsModal() {
  document.getElementById('modal-snapshots').classList.add('open');
  await renderSnapshotsList();
}
function closeSnapshotsModal() {
  document.getElementById('modal-snapshots').classList.remove('open');
}
document.getElementById('modal-snapshots').addEventListener('click', function(e) {
  if (e.target === this) closeSnapshotsModal();
});

async function renderSnapshotsList() {
  const el = document.getElementById('snapshots-list');
  el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">Chargement…</div>';
  if (!window._sb) { el.innerHTML = '<div class="empty" style="padding:24px">Supabase non connecté</div>'; return; }
  try {
    // IMPORTANT : ne JAMAIS sélectionner la colonne `data` ici (tout le JSON de la collection) —
    // seule `counts` (résumé léger, voir _snapshotCounts) est nécessaire pour l'affichage de la
    // liste. La colonne `data` complète n'est téléchargée que pour UN snapshot précis, à la
    // restauration (restoreSnapshot) ou à la comparaison journal (compareJournal).
    const { data, error } = await window._sb.from('collection_snapshots')
      .select('id, created_at, label, counts').order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || !data.length) { el.innerHTML = '<div class="empty" style="padding:24px">Aucun snapshot pour l\'instant — utilise "📸 Nouveau snapshot" avant un import ou une fusion importante.</div>'; return; }
    el.innerHTML = data.map(row => {
      const c = row.counts;
      const counts = !c
        ? 'détails indisponibles (snapshot créé avant la migration `counts`)'
        : c.remoteFormat
          ? `${c.albums} albums (snapshot de sécurité — albums uniquement)`
          : `${c.albums} albums · ${c.tracks} morceaux · ${c.wishlist} wishlist`;
      return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:500">${esc(row.label || 'Snapshot')}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${new Date(row.created_at).toLocaleString('fr-FR')} — ${counts}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm btn-danger" onclick="restoreSnapshot(${row.id})">↩ Restaurer</button>
          <button class="btn btn-sm" onclick="deleteSnapshot(${row.id})">🗑</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    console.error('renderSnapshotsList error', e);
    const msg = /relation .* does not exist|not found/i.test(e.message || '')
      ? "Table collection_snapshots absente — voir la migration SQL en commentaire du code (fonction createSnapshot)"
      : (e.message || String(e));
    el.innerHTML = `<div class="empty" style="padding:24px">Erreur de chargement : ${esc(msg)}</div>`;
  }
}

async function restoreSnapshot(id) {
  if (!confirm("Restaurer ce snapshot va REMPLACER la collection actuelle par son contenu, puis resynchroniser vers Supabase.\n\nUn snapshot de l'état actuel sera créé automatiquement avant, par sécurité.\n\nContinuer ?")) return;
  // Bug corrigé v2026.07.10-20 : updateNavBadges() (appelé juste après la restauration, quelques
  // lignes plus bas) déclenche pruneWishlistOwned() de façon DÉBOUNCÉE (80ms, voir updateNavBadges).
  // Comme saveToSupabase() ci-dessous prend largement plus de 80ms (plusieurs allers-retours
  // réseau pour albums/tracks avant même de sérialiser la wishlist), le prune débounce pouvait se
  // déclencher PENDANT l'upload, muter `wishlist` en mémoire (retrait des entrées jugées déjà
  // possédées) et ce sont ces données déjà amputées qui finissaient sérialisées et envoyées à
  // Supabase — donnant l'impression que la restauration "ne prenait pas". _restoringSnapshot
  // bloque toute purge auto (ici et dans renderWishlist()) tant que la restauration n'est pas
  // entièrement persistée.
  _restoringSnapshot = true;
  try {
    toast("Snapshot de sécurité de l'état actuel…");
    await createSnapshot(`Auto — avant restauration du snapshot #${id}`, { _remoteFormat: false, albums, tracks, associations, rymAssociations, wishlist, trackWishlist });

    const { data, error } = await window._sb.from('collection_snapshots').select('data').eq('id', id).single();
    if (error) throw error;
    const d = data.data || {};

    if (d._remoteFormat) {
      // Snapshot de sécurité auto : ne contient que les albums (état remote au moment du
      // risque) — on ne touche pas tracks/wishlist/associations, non concernés par ce risque.
      albums = (d.albums || []).map(_rowToLocalAlbum);
    } else {
      albums          = d.albums || [];
      tracks          = d.tracks || [];
      associations    = d.associations || [];
      rymAssociations = d.rymAssociations || [];
      wishlist        = d.wishlist || [];
      trackWishlist   = d.trackWishlist || [];
    }

    nextId = Math.max(nextId, computeNextId());
    repairDuplicateIds();
    invalidateCache();
    renderAlbums(); renderTracks(); updateNavBadges();
    toast('Restauration en cours — synchronisation Supabase…');
    await saveToSupabase();
    saveToStorage();
    closeSnapshotsModal();
    toast('✓ Collection restaurée depuis le snapshot');
  } catch(e) {
    console.error('restoreSnapshot error', e);
    toast('Erreur lors de la restauration : ' + (e.message || e), 'error');
  } finally {
    _restoringSnapshot = false;
    // La purge auto était bloquée pendant toute la restauration — on la relance maintenant,
    // une fois pour de bon, sur l'état définitivement persisté (comportement normal identique
    // à n'importe quel autre chargement de page).
    updateNavBadges();
  }
}

async function deleteSnapshot(id) {
  if (!confirm('Supprimer définitivement ce snapshot ?')) return;
  try {
    await window._sb.from('collection_snapshots').delete().eq('id', id);
    await renderSnapshotsList();
  } catch(e) {
    toast('Erreur suppression snapshot : ' + (e.message || e), 'error');
  }
}

// ===================== JOURNAL DES CHANGEMENTS (diff vs snapshot) =====================
// Quasi sous-produit du système de snapshots ci-dessus : plutôt que de rejouer une
// synchro/import pour deviner ce qui a changé, on compare simplement l'état actuel de
// `albums` à celui capturé dans un snapshot choisi. Ajouts/suppressions par clé
// (artiste, album) normalisée ; "déplacé" = changement de dossier(s) ; note MusicBee
// changée affichée à part. Pas de détection de fusion dédiée (trop ambigu à déduire d'un
// simple diff d'ids) — une fusion apparaît ici comme 1 suppression + 1 modification.
function _snapshotAlbums(d) {
  if (!d) return [];
  return d._remoteFormat ? (d.albums || []).map(_rowToLocalAlbum) : (d.albums || []);
}

function _journalFolderLabel(a) {
  const labels = [];
  if (a.folders?.includes('stock') || a.primaryFolder === 'stock') labels.push('📦 Stock');
  if (a.okFolder) labels.push('✅ Ok');
  if (a.forSale) labels.push('💸 Vendre');
  if (!labels.length) labels.push('🎵 Discographie');
  return labels.join(' + ');
}

async function renderJournal() {
  const sel = document.getElementById('journal-snapshot-select');
  const status = document.getElementById('journal-status');
  const results = document.getElementById('journal-results');
  if (!window._sb) {
    sel.innerHTML = '<option>Supabase non connecté</option>';
    results.innerHTML = '<div class="empty" style="padding:24px">Le journal nécessite Supabase (les snapshots y sont stockés).</div>';
    return;
  }
  sel.innerHTML = '<option>Chargement…</option>';
  try {
    const { data, error } = await window._sb.from('collection_snapshots')
      .select('id, created_at, label').order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || !data.length) {
      sel.innerHTML = '<option value="">Aucun snapshot</option>';
      results.innerHTML = '<div class="empty" style="padding:24px">Aucun snapshot disponible pour comparer — crée-en un avec "📸 Nouveau snapshot" avant ton prochain import.</div>';
      status.textContent = '';
      return;
    }
    sel.innerHTML = data.map(row =>
      `<option value="${row.id}">${new Date(row.created_at).toLocaleString('fr-FR')} — ${esc(row.label || 'Snapshot')}</option>`
    ).join('');
    status.textContent = `${data.length} snapshot(s) disponible(s)`;
    // Compare automatiquement contre le plus récent à l'ouverture de l'écran
    await compareJournal();
  } catch(e) {
    console.error('renderJournal error', e);
    sel.innerHTML = '<option value="">Erreur</option>';
    const msg = /relation .* does not exist|not found/i.test(e.message || '')
      ? "Table collection_snapshots absente — voir la migration SQL en commentaire du code (fonction createSnapshot)"
      : (e.message || String(e));
    results.innerHTML = `<div class="empty" style="padding:24px">Erreur de chargement : ${esc(msg)}</div>`;
  }
}

async function compareJournal() {
  const sel = document.getElementById('journal-snapshot-select');
  const status = document.getElementById('journal-status');
  const results = document.getElementById('journal-results');
  const id = sel?.value;
  if (!id) return;
  status.textContent = 'Comparaison…';
  try {
    const { data, error } = await window._sb.from('collection_snapshots').select('created_at, label, data').eq('id', id).single();
    if (error) throw error;
    const refAlbums = _snapshotAlbums(data.data || {});
    const refByKey = new Map(refAlbums.map(a => [normalizeKey(a.artist, a.album), a]));
    const curByKey = new Map(albums.map(a => [normalizeKey(a.artist, a.album), a]));

    const added = [], removed = [], moved = [], notedChanged = [];
    curByKey.forEach((a, k) => {
      const ref = refByKey.get(k);
      if (!ref) { added.push(a); return; }
      const refFolder = _journalFolderLabel(ref);
      const curFolder = _journalFolderLabel(a);
      if (refFolder !== curFolder) moved.push({ a, from: refFolder, to: curFolder });
      if ((ref.note || 0) !== (a.note || 0)) notedChanged.push({ a, from: ref.note || 0, to: a.note || 0 });
    });
    refByKey.forEach((ref, k) => { if (!curByKey.has(k)) removed.push(ref); });

    const total = added.length + removed.length + moved.length + notedChanged.length;
    status.textContent = `Comparé au ${new Date(data.created_at).toLocaleString('fr-FR')} (${data.label || 'Snapshot'}) — ${total} changement(s)`;

    const section = (title, icon, rows, renderRow) => rows.length ? `
      <div style="margin-bottom:22px">
        <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:8px">${icon} ${title} (${rows.length})</div>
        <div class="table-wrap"><table><tbody>${rows.map(renderRow).join('')}</tbody></table></div>
      </div>` : '';

    results.innerHTML = (!total
      ? '<div class="empty" style="padding:24px">🎉 Aucun changement depuis ce snapshot.</div>'
      : '') +
      section('Ajoutés', '➕', added, a => `<tr>
        <td style="font-weight:500">${esc(a.album)}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(a.artist)}</td>
        <td style="font-size:11px;color:var(--text3)">${_journalFolderLabel(a)}</td>
      </tr>`) +
      section('Supprimés', '➖', removed, a => `<tr>
        <td style="font-weight:500;text-decoration:line-through;color:var(--text3)">${esc(a.album)}</td>
        <td style="font-size:12px;color:var(--text3)">${esc(a.artist)}</td>
        <td style="font-size:11px;color:var(--text3)">${_journalFolderLabel(a)}</td>
      </tr>`) +
      section('Déplacés (changement de dossier)', '📂', moved, r => `<tr>
        <td style="font-weight:500">${esc(r.a.album)}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(r.a.artist)}</td>
        <td style="font-size:11px;color:var(--text3)">${r.from} → ${r.to}</td>
      </tr>`) +
      section('Note MusicBee changée', '⭐', notedChanged, r => `<tr>
        <td style="font-weight:500">${esc(r.a.album)}</td>
        <td style="font-size:12px;color:var(--text2)">${esc(r.a.artist)}</td>
        <td style="font-size:11px;color:var(--text3);font-family:var(--mono)">${r.from || '–'} → ${r.to || '–'}</td>
      </tr>`);
  } catch(e) {
    console.error('compareJournal error', e);
    status.textContent = '';
    results.innerHTML = `<div class="empty" style="padding:24px">Erreur : ${esc(e.message || String(e))}</div>`;
  }
}

// ===================== DASHBOARD D'INSIGHTS =====================
// Todo section 11, "Dashboard d'insights" (nouveau — discuté juillet 2026). Tout ce qui suit
// est calculé côté client à partir des données déjà chargées (albums[], _lastfmTrackCounts) —
// sauf l'évolution des écoutes par mois, qui nécessite un appel dédié à l'API Last.fm (weekly
// charts), fait UNIQUEMENT à la demande (bouton), jamais en auto : reconstituer un historique
// complet sur 100k+ scrobbles représenterait des centaines d'appels API pour un gain marginal
// sur un simple dashboard — même logique de prudence que "Scrobbles récents", volontairement
// non persisté lui aussi.

function insightsOwnedAlbums() {
  return ownedAlbumsForCovers();
}

function computeGenreDistribution() {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    const g = a.genre || 'Sans genre';
    counts[g] = (counts[g] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
}

// Année d'origine effective d'un album, pour les calculs (contrairement à origYearBadge() qui
// est un affichage informatif et signale une divergence sans trancher) — ici il faut UNE seule
// valeur par album. Priorité : mb_original_year (release-group MusicBrainz, généralement la
// source la plus fiable pour la 1re parution) → discogs_master_year (master release Discogs) →
// a.year en dernier recours (année du pressage/édition en collection, pas forcément l'originale).
function originalYearOf(a) {
  return parseInt(a.mb_original_year || a.discogs_master_year || a.year, 10);
}

function computeDecadeDistribution() {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    const y = originalYearOf(a);
    if (!y || y < 1900 || y > 2100) return;
    const dec = (Math.floor(y / 10) * 10) + 's';
    counts[dec] = (counts[dec] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
}

// Top artistes par ÉCOUTES last.fm (agrégé depuis _lastfmTrackCounts, tous morceaux confondus,
// possédés ou non) — à comparer au classement par NOMBRE D'ALBUMS POSSÉDÉS ci-dessous : les deux
// classements divergent souvent (artistes très écoutés en streaming/scrobbles mais peu achetés,
// ou l'inverse pour des artistes achetés "en confiance" mais peu réécoutés).
function computeTopArtistsByPlays(n = 10) {
  const counts = {};
  Object.values(_lastfmTrackCounts).forEach(d => {
    if (!d.artist) return;
    counts[d.artist] = (counts[d.artist] || 0) + (d.plays || 0);
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function computeTopArtistsByOwned(n = 10) {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    if (!a.artist) return;
    counts[a.artist] = (counts[a.artist] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Rendu générique d'une liste à barres horizontales (genres, décennies, top artistes) — même
// composant réutilisé pour les 4 blocs du dashboard, pas de lib de graphique externe (cohérent
// avec le reste de l'app, aucune dépendance JS ajoutée hors Supabase/SheetJS déjà présentes).
function renderBarList(containerId, data, opts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!data.length) { el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Aucune donnée.</div>'; return; }
  const max = Math.max(...data.map(d => d[1]), 1);
  const labelWidth = opts?.labelWidth || 120;
  el.innerHTML = data.map(([label, val]) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:${labelWidth}px;flex-shrink:0;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(label)}">${esc(label)}</div>
      <div style="flex:1;background:var(--bg3);border-radius:3px;overflow:hidden;height:14px">
        <div style="width:${(val/max*100).toFixed(1)}%;background:var(--accent);height:100%"></div>
      </div>
      <div class="mono" style="width:48px;text-align:right;font-size:11px;color:var(--text3);flex-shrink:0">${val.toLocaleString('fr-FR')}</div>
    </div>`).join('');
}

// ===================== "CE JOUR-LÀ" =====================
// Todo section 11, item ⬜ « encart type "il y a exactement N ans, tu écoutais X" ou "cet album
// fête ses N ans aujourd'hui" — comparaison de dates déjà en base, coût quasi nul ». 2 volets
// bien distincts en coût : (A) anniversaires de sortie — 100% côté client, à partir de
// album.release_date déjà persisté (rempli une fois par Discogs/MusicBrainz lors du premier
// enrichissement, cf. fetchAllTracklists) quand la source donne une date complète (jour/mois
// disponibles, pas juste l'année — donc forcément partiel, beaucoup d'albums n'auront jamais de
// correspondance exacte). (B) écoutes passées ce même jour calendaire les années précédentes —
// nécessite un appel last.fm par année en arrière (user.getrecenttracks borné à CE jour via
// from=/to=), donc à la demande uniquement (bouton), jamais persisté : le résultat dépend du
// jour du calendrier et se périmerait de toute façon dès le lendemain.

function todaysAlbumAnniversaries() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return insightsOwnedAlbums()
    .filter(a => a.release_date && /^\d{4}-\d{2}-\d{2}/.test(a.release_date))
    .filter(a => a.release_date.slice(5, 7) === mm && a.release_date.slice(8, 10) === dd)
    .map(a => ({ a, years: now.getFullYear() - parseInt(a.release_date.slice(0, 4), 10) }))
    .filter(r => r.years > 0)
    .sort((x, y) => y.years - x.years);
}

function renderTodayAnniversaries() {
  const el = document.getElementById('ins-anniversaries');
  if (!el) return;
  const rows = todaysAlbumAnniversaries();
  if (!rows.length) {
    el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Aucun anniversaire de sortie aujourd\'hui — nécessite une date de sortie précise au jour près (pas juste l\'année) sur au moins un album, rempli automatiquement par les enrichissements Discogs/MusicBrainz existants.</div>';
    return;
  }
  el.innerHTML = rows.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="editAlbum('${sid(r.a.id)}')">
    <div><div style="font-weight:500">${esc(r.a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(r.a.artist)}</div></div>
    <span style="font-family:var(--mono);color:var(--accent)">🎂 ${r.years} an${r.years > 1 ? 's' : ''}</span>
  </div>`).join('');
}

let _onThisDayResults = []; // session seulement — dépend du jour du calendrier, pas de sens de persister
const ON_THIS_DAY_YEARS_BACK = 12; // large marge ; les années sans scrobble ne produisent simplement aucune entrée

async function loadOnThisDayListening() {
  if (!_lastfmUser || !_lastfmApiKey) { toast('Configure last.fm dans Import / Export d\'abord', 'warn'); return; }
  const btn = document.getElementById('ins-onthisday-btn');
  const status = document.getElementById('ins-onthisday-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Chargement…'; }
  _onThisDayResults = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  try {
    for (let y = currentYear - 1; y >= currentYear - ON_THIS_DAY_YEARS_BACK; y--) {
      if (status) status.textContent = `Année ${y}…`;
      const from = Math.floor(new Date(y, now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000);
      const to = Math.floor(new Date(y, now.getMonth(), now.getDate(), 23, 59, 59).getTime() / 1000);
      const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=200&from=${from}&to=${to}&extended=0`;
      const res = await fetch(url);
      const data = await res.json();
      const raw = data.recenttracks?.track || [];
      const list = (Array.isArray(raw) ? raw : [raw]).filter(t => t && t.name);
      if (list.length) {
        _onThisDayResults.push({
          year: y,
          tracks: list.map(t => ({ artist: t.artist?.['#text'] || '', album: t.album?.['#text'] || '', name: t.name })),
        });
      }
      await new Promise(r => setTimeout(r, 300));
    }
    toast(_onThisDayResults.length ? `${_onThisDayResults.length} année(s) avec des écoutes ce jour-là` : 'Aucune écoute trouvée ce jour-là les années précédentes');
  } catch(e) {
    console.error('loadOnThisDayListening:', e.message || e);
    toast('Erreur last.fm : ' + (e.message || e), 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Charger les écoutes passées'; }
    if (status) status.textContent = '';
  }
  renderOnThisDayListening();
}

function renderOnThisDayListening() {
  const el = document.getElementById('ins-onthisday-list');
  if (!el) return;
  if (!_onThisDayResults.length) {
    el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Clique sur "🔄 Charger les écoutes passées" pour voir ce que tu écoutais ce même jour les années précédentes.</div>';
    return;
  }
  const now = new Date();
  el.innerHTML = _onThisDayResults.map(r => {
    const years = now.getFullYear() - r.year;
    const sample = r.tracks.slice(0, 6);
    return `<div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Il y a ${years} an${years > 1 ? 's' : ''} (${r.year}) — ${r.tracks.length} écoute(s)</div>
      <div style="font-size:12px;color:var(--text3)">${sample.map(t => `${esc(t.artist)} — ${esc(t.name)}`).join(' · ')}${r.tracks.length > sample.length ? '…' : ''}</div>
    </div>`;
  }).join('');
}

// ===================== INSIGHTS — COMPLÉMENTS "GRATUITS" =====================
// Suite à la question d'Antoine sur les améliorations possibles de l'onglet Insights : tout ce
// qui suit est 100% calculé côté client à partir de données déjà chargées (albums[], wishlist[],
// lastfmData[], listeningHeatmap) — aucun appel réseau supplémentaire, aucune migration SQL.

// --- Composition de la collection ---
function computeSupportDistribution() {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    const label = _journalFolderLabel(a); // réutilise le même regroupement que le Journal
    counts[label] = (counts[label] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

const FORMAT_LABELS = { flac: 'FLAC', mp3: 'MP3', digital: 'Numérique (autre)' };
function computeFormatDistribution() {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    if (a.format) counts[FORMAT_LABELS[a.format] || a.format] = (counts[FORMAT_LABELS[a.format] || a.format] || 0) + 1;
    else if (a.cd) counts['CD sans fichier numérique'] = (counts['CD sans fichier numérique'] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function computeCompilationRatio() {
  const counts = { 'Albums studio': 0, 'Compilations': 0 };
  insightsOwnedAlbums().forEach(a => { counts[a.isCompilation ? 'Compilations' : 'Albums studio']++; });
  return Object.entries(counts);
}

function computeTopLabels(n = 10) {
  const counts = {};
  insightsOwnedAlbums().forEach(a => { if (a.label) counts[a.label] = (counts[a.label] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// --- Provenance des données : proportion manuel / auto (Discogs, MusicBrainz) / import direct
// (MusicBee XML, Discogs CSV — authoritatif, jamais tracé dans field_provenance) / vide, pour
// les 4 champs suivis par le système de provenance existant (v2026.07.10-01, PROVENANCE_FIELDS/
// PROVENANCE_FIELD_LABELS réutilisés tels quels). Un "data health" en un coup d'œil, différent
// de l'onglet Audit (qui corrige des divergences plutôt qu'il n'en mesure les proportions).
function computeProvenanceBreakdown() {
  const owned = insightsOwnedAlbums();
  return PROVENANCE_FIELDS.map(field => {
    const row = { field, manuel: 0, auto: 0, import: 0, vide: 0 };
    owned.forEach(a => {
      const has = !!(a[field] && String(a[field]).trim());
      const prov = a.field_provenance?.[field]?.source;
      if (!has) row.vide++;
      else if (prov === 'manual') row.manuel++;
      else if (prov === 'discogs' || prov === 'musicbrainz') row.auto++;
      else row.import++;
    });
    return row;
  });
}
function renderProvenanceTable() {
  const el = document.getElementById('ins-provenance');
  if (!el) return;
  const rows = computeProvenanceBreakdown();
  const total = insightsOwnedAlbums().length || 1;
  const seg = (val, color) => val ? `<div style="width:${(val/total*100).toFixed(1)}%;background:${color};height:100%"></div>` : '';
  el.innerHTML = `<div style="display:grid;grid-template-columns:70px 1fr auto;gap:8px;align-items:center;font-size:11px;color:var(--text3);margin-bottom:6px">
      <span></span><span></span>
      <span>🔒 manuel · 🔄 auto · 📥 import · ∅ vide</span>
    </div>` +
    rows.map(r => `
    <div style="display:grid;grid-template-columns:70px 1fr auto;gap:8px;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;color:var(--text2)">${esc(PROVENANCE_FIELD_LABELS[r.field])}</span>
      <div style="display:flex;height:12px;border-radius:3px;overflow:hidden;background:var(--bg3)">
        ${seg(r.manuel, 'var(--accent)')}${seg(r.auto, 'var(--purple, #b08cff)')}${seg(r.import, 'var(--text3)')}${seg(r.vide, 'transparent')}
      </div>
      <span class="mono" style="font-size:10px;color:var(--text3);white-space:nowrap">${r.manuel}·${r.auto}·${r.import}·${r.vide}</span>
    </div>`).join('');
}

// --- Notes & goût ---
function computeNoteDistribution() {
  const counts = {};
  insightsOwnedAlbums().forEach(a => {
    if (!a.note) return;
    const bucket = (Math.round(a.note * 2) / 2).toFixed(1).replace('.0', '') + '★';
    counts[bucket] = (counts[bucket] || 0) + 1;
  });
  // Tri par valeur d'étoile croissante plutôt que par nombre d'albums (lisibilité d'un histogramme)
  return Object.entries(counts).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
}

function computeRymDeltaSummary() {
  let sum = 0, count = 0;
  insightsOwnedAlbums().forEach(a => {
    if (!a.note) return;
    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    if (!rymEntry || !rymEntry.rating) return;
    sum += (a.note - rymEntry.rating);
    count++;
  });
  return { avg: count ? sum / count : null, count };
}

// Top genres × décennies (todo-adjacent — matrice compacte plutôt qu'une vraie heatmap 2D, pas
// de lib de graphique dans l'app). Limité aux 6 genres les plus représentés pour rester lisible.
function computeGenreDecadeMatrix() {
  const topGenres = computeGenreDistribution().slice(0, 6).map(([g]) => g);
  const matrix = {}; // genre -> { decade: count }
  const decadesSet = new Set();
  topGenres.forEach(g => matrix[g] = {});
  insightsOwnedAlbums().forEach(a => {
    const g = a.genre || 'Sans genre';
    if (!topGenres.includes(g)) return;
    const y = originalYearOf(a);
    if (!y || y < 1900 || y > 2100) return;
    const dec = (Math.floor(y / 10) * 10) + 's';
    decadesSet.add(dec);
    matrix[g][dec] = (matrix[g][dec] || 0) + 1;
  });
  const decades = [...decadesSet].sort();
  return { genres: topGenres, decades, matrix };
}
function renderGenreDecadeMatrix() {
  const el = document.getElementById('ins-genre-decade');
  if (!el) return;
  const { genres, decades, matrix } = computeGenreDecadeMatrix();
  if (!genres.length || !decades.length) { el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Pas assez de données.</div>'; return; }
  const maxVal = Math.max(1, ...genres.flatMap(g => decades.map(d => matrix[g][d] || 0)));
  el.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:11px">
    <thead><tr><th style="text-align:left;padding:3px 8px 3px 0;color:var(--text3);font-weight:500"></th>${decades.map(d => `<th style="padding:3px 6px;color:var(--text3);font-weight:500">${d}</th>`).join('')}</tr></thead>
    <tbody>${genres.map(g => `<tr>
      <td style="padding:3px 8px 3px 0;color:var(--text2);white-space:nowrap">${esc(g)}</td>
      ${decades.map(d => {
        const v = matrix[g][d] || 0;
        const alpha = v ? (0.15 + 0.85 * v / maxVal).toFixed(2) : 0;
        return `<td style="padding:3px 6px;text-align:center;background:rgba(var(--accent-rgb,124,58,237),${alpha});border-radius:3px;color:${v ? 'var(--text)' : 'var(--text3)'}">${v || '·'}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// Écoutes moyennes par tranche de note perso (lastfmData déjà chargé, index construit une seule
// fois par appel pour éviter un .find() linéaire par album sur toute la collection).
function computeNoteVsPlaysCorrelation() {
  const lfIdx = new Map(lastfmData.map(d => [normalizeKey(d.artist, d.album), d.plays || 0]));
  const buckets = { 'Non noté': { sum: 0, n: 0 }, '≤2★': { sum: 0, n: 0 }, '2.5-3★': { sum: 0, n: 0 }, '3.5-4★': { sum: 0, n: 0 }, '4.5-5★': { sum: 0, n: 0 } };
  insightsOwnedAlbums().forEach(a => {
    const plays = lfIdx.get(normalizeKey(a.artist, a.album)) ?? lfIdx.get(normalizeKey(cleanDiscogsArtist(a.artist), a.album)) ?? 0;
    let key;
    if (!a.note) key = 'Non noté';
    else if (a.note <= 2) key = '≤2★';
    else if (a.note <= 3) key = '2.5-3★';
    else if (a.note <= 4) key = '3.5-4★';
    else key = '4.5-5★';
    buckets[key].sum += plays; buckets[key].n++;
  });
  return Object.entries(buckets)
    .filter(([, v]) => v.n > 0)
    .map(([label, v]) => [label, Math.round(v.sum / v.n)]);
}

// --- Wishlist ---
function computeWishlistSummary() {
  const byPrio = { high: 0, mid: 0, low: 0 };
  let withRym = 0;
  wishlist.forEach(w => {
    if (w.prio) byPrio[w.prio] = (byPrio[w.prio] || 0) + 1;
    if (w.rymRating) withRym++;
  });
  return { total: wishlist.length, byPrio, withRym };
}

// --- Streak d'écoute — calculé sur listeningHeatmap déjà chargé (v2026.07.10-15), donc AUCUN
// appel last.fm supplémentaire ici : si la heatmap n'a jamais été chargée, retourne des zéros.
function computeListeningStreaks() {
  if (!listeningHeatmap.length) return { current: 0, best: 0 };
  const byDate = new Set(listeningHeatmap.filter(d => d.plays > 0).map(d => d.date));
  const toISO = (d) => d.toISOString().slice(0, 10);
  // Streak en cours : en partant d'aujourd'hui (ou hier si rien aujourd'hui, la journée n'étant
  // pas finie), recule tant que le jour précédent a des écoutes.
  let cursor = new Date();
  if (!byDate.has(toISO(cursor))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (byDate.has(toISO(cursor))) { current++; cursor.setDate(cursor.getDate() - 1); }
  // Meilleur streak sur la fenêtre chargée (90 jours par défaut)
  const sortedDates = listeningHeatmap.map(d => d.date).sort();
  let best = 0, run = 0, prev = null;
  sortedDates.forEach(dateStr => {
    const hasPlay = byDate.has(dateStr);
    if (hasPlay) {
      if (prev) {
        const diffDays = Math.round((new Date(dateStr) - new Date(prev)) / 86400000);
        run = diffDays === 1 ? run + 1 : 1;
      } else run = 1;
      best = Math.max(best, run);
      prev = dateStr;
    }
  });
  return { current, best };
}

function renderInsights() {
  const owned = insightsOwnedAlbums();
  const rated = owned.filter(a => a.note);
  const totalPlays = Object.values(_lastfmTrackCounts).reduce((s, d) => s + (d.plays || 0), 0);

  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setText('ins-owned', owned.length.toLocaleString('fr-FR'));
  setText('ins-plays', totalPlays.toLocaleString('fr-FR'));
  setText('ins-rated-pct', owned.length ? Math.round(rated.length / owned.length * 100) + '%' : '–');
  setText('ins-avg-note', rated.length ? (rated.reduce((s, a) => s + a.note, 0) / rated.length).toFixed(1) : '–');

  renderBarList('ins-genres', computeGenreDistribution());
  renderBarList('ins-decades', computeDecadeDistribution(), { labelWidth: 56 });
  renderBarList('ins-top-played', computeTopArtistsByPlays());
  renderBarList('ins-top-owned', computeTopArtistsByOwned());

  renderListeningEvolution();
  renderListeningHeatmap();
  renderGenreEvolution();
  renderTodayAnniversaries();
  renderOnThisDayListening();

  // ── Compléments "gratuits" (100% client, aucun appel réseau, aucune migration) ──
  const avgCompleteness = owned.length ? owned.reduce((s, a) => s + computeAlbumCompleteness(a).score, 0) / owned.length : 0;
  setText('ins-avg-completeness', owned.length ? `${avgCompleteness.toFixed(1)} / ${COMPLETENESS_CRITERIA.length}` : '–');
  const rymDelta = computeRymDeltaSummary();
  setText('ins-rym-delta', rymDelta.count ? `${rymDelta.avg > 0 ? '+' : ''}${rymDelta.avg.toFixed(2)}★` : '–');
  const streaks = computeListeningStreaks();
  setText('ins-streak', listeningHeatmap.length ? `${streaks.current} j (record ${streaks.best} j)` : '–');
  const wishSummary = computeWishlistSummary();
  setText('ins-wish-summary', wishSummary.total ? `${wishSummary.total} (🔴${wishSummary.byPrio.high||0} 🟡${wishSummary.byPrio.mid||0} 🟢${wishSummary.byPrio.low||0})` : '–');

  renderBarList('ins-support', computeSupportDistribution(), { labelWidth: 130 });
  renderBarList('ins-format', computeFormatDistribution(), { labelWidth: 130 });
  renderBarList('ins-compilations', computeCompilationRatio(), { labelWidth: 100 });
  renderBarList('ins-labels', computeTopLabels(), { labelWidth: 130 });
  renderProvenanceTable();
  renderBarList('ins-note-dist', computeNoteDistribution(), { labelWidth: 40 });
  renderGenreDecadeMatrix();
  renderBarList('ins-note-plays', computeNoteVsPlaysCorrelation(), { labelWidth: 70 });
}

// ── Évolution des écoutes par mois (weekly charts Last.fm, à la demande) ──────────────────
function renderListeningEvolution() {
  const wrap = document.getElementById('ins-evolution');
  const meta = document.getElementById('ins-evolution-meta');
  if (!wrap) return;
  if (!listeningEvolution.length) {
    wrap.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Pas encore calculée — clique sur "🔄 Charger l\'historique".</div>';
    if (meta) meta.textContent = '';
    return;
  }
  const max = Math.max(...listeningEvolution.map(d => d.plays), 1);
  wrap.innerHTML = `<div style="display:flex;align-items:flex-end;gap:3px;height:110px">` +
    listeningEvolution.map(d => `
      <div style="flex:1;display:flex;align-items:flex-end;height:100%" title="${d.month} : ${d.plays.toLocaleString('fr-FR')} écoutes">
        <div style="width:100%;background:var(--accent);border-radius:2px 2px 0 0;height:${Math.max(2, d.plays / max * 100).toFixed(1)}%"></div>
      </div>`).join('') +
    `</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:4px">
      <span>${listeningEvolution[0]?.month || ''}</span><span>${listeningEvolution[listeningEvolution.length - 1]?.month || ''}</span>
    </div>`;
  if (meta) meta.textContent = _listeningEvolutionComputedAt ? `Calculé ${formatProvenanceAge(_listeningEvolutionComputedAt)}` : '';
}

// Reconstitue l'évolution mensuelle des écoutes via les weekly charts Last.fm : liste des
// semaines disponibles depuis l'inscription (user.getweeklychartlist), puis le total d'écoutes
// de chacune des 104 dernières semaines (~2 ans, via user.getweeklyartistchart — un seul appel
// par semaine, somme des playcounts par artiste = total de la semaine). Bornée à 2 ans pour
// rester raisonnable : l'historique complet du compte (100k+ scrobbles, potentiellement des
// centaines de semaines) coûterait des centaines d'appels séquentiels pour un gain marginal sur
// ce dashboard. Résultat mis en cache (listeningEvolution), jamais recalculé automatiquement.
async function loadListeningEvolution() {
  if (!_lastfmUser || !_lastfmApiKey) { toast('Configure last.fm dans Import / Export d\'abord', 'warn'); return; }
  const btn = document.getElementById('ins-evolution-btn');
  const meta = document.getElementById('ins-evolution-meta');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Chargement…'; }
  try {
    const listUrl = `${LASTFM_BASE}?method=user.getweeklychartlist&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json`;
    const listRes = await fetch(listUrl);
    const listData = await listRes.json();
    const allWeeks = listData.weeklychartlist?.chart || [];
    if (!allWeeks.length) throw new Error('Aucune semaine disponible côté last.fm');
    const weeks = allWeeks.slice(-104); // ~2 ans max

    // Index artiste normalisé (toutes variantes) → genre, construit une seule fois avant la
    // boucle, à partir des albums possédés — sert à ventiler chaque total hebdo par genre sans
    // aucun appel réseau supplémentaire (voir déclaration de genreEvolution).
    const artistGenreIndex = new Map();
    insightsOwnedAlbums().forEach(a => {
      if (!a.genre) return;
      artistVariants(a.artist).forEach(v => { if (!artistGenreIndex.has(v)) artistGenreIndex.set(v, a.genre); });
    });
    const genreForArtist = (name) => {
      for (const v of artistVariants(name)) { if (artistGenreIndex.has(v)) return artistGenreIndex.get(v); }
      return 'Sans genre';
    };

    const monthTotals = {};
    const monthGenreTotals = {}; // { 'YYYY-MM': { genre: plays } }
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      if (meta) meta.textContent = `Semaine ${i + 1}/${weeks.length}…`;
      const url = `${LASTFM_BASE}?method=user.getweeklyartistchart&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&from=${w.from}&to=${w.to}`;
      const res = await fetch(url);
      const data = await res.json();
      const artists = data.weeklyartistchart?.artist || [];
      const weekTotal = artists.reduce((s, a) => s + (parseInt(a.playcount, 10) || 0), 0);
      const monthKey = new Date(parseInt(w.from, 10) * 1000).toISOString().slice(0, 7); // YYYY-MM
      monthTotals[monthKey] = (monthTotals[monthKey] || 0) + weekTotal;
      const bucket = (monthGenreTotals[monthKey] = monthGenreTotals[monthKey] || {});
      artists.forEach(a => {
        const plays = parseInt(a.playcount, 10) || 0;
        if (!plays) return;
        const g = genreForArtist(a.name);
        bucket[g] = (bucket[g] || 0) + plays;
      });
      if (i % 8 === 7) await new Promise(r => setTimeout(r, 200)); // pause légère tous les 8 appels
    }
    listeningEvolution = Object.entries(monthTotals)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, plays]) => ({ month, plays }));
    genreEvolution = Object.entries(monthGenreTotals)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, genres]) => ({ month, genres }));
    _listeningEvolutionComputedAt = new Date().toISOString();
    _genreEvolutionComputedAt = _listeningEvolutionComputedAt;
    saveToStorage();
    renderListeningEvolution();
    renderGenreEvolution();
    toast('Historique d\'écoute chargé');
  } catch(e) {
    console.error('loadListeningEvolution:', e.message || e);
    toast('Erreur last.fm : ' + (e.message || e), 'warn');
    if (meta) meta.textContent = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Charger l\'historique (24 derniers mois)'; }
  }
}

// Comparaison de période plutôt qu'une vraie série temporelle par genre (pas de lib de
// graphique dans l'app, et un multi-lignes 12 genres × 24 mois serait illisible en barres) :
// les 12 derniers mois disponibles vs les 12 précédents, triés par plus gros mouvement absolu —
// répond directement à l'exemple de la todo (« plus de jazz cette année qu'il y a deux ans »)
// dans la limite de la fenêtre chargée (24 mois max, cf. loadListeningEvolution).
function renderGenreEvolution() {
  const el = document.getElementById('ins-genre-evolution');
  const meta = document.getElementById('ins-genre-evolution-meta');
  if (!el) return;
  if (!genreEvolution.length) {
    el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Pas encore calculée — clique sur "🔄 Charger l\'historique" ci-dessus (même calcul, ventilé par genre).</div>';
    if (meta) meta.textContent = '';
    return;
  }
  const months = genreEvolution.map(d => d.month);
  const half = Math.ceil(months.length / 2);
  const olderMonths = new Set(months.slice(0, half));
  const recentMonths = new Set(months.slice(half));
  const sums = {}; // genre → { older, recent }
  genreEvolution.forEach(d => {
    const target = recentMonths.has(d.month) ? 'recent' : 'older';
    Object.entries(d.genres).forEach(([g, plays]) => {
      sums[g] = sums[g] || { older: 0, recent: 0 };
      sums[g][target] += plays;
    });
  });
  const rows = Object.entries(sums)
    .map(([genre, v]) => ({ genre, ...v, delta: v.recent - v.older }))
    .filter(r => r.older || r.recent)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  if (meta) meta.textContent = `${olderMonths.size} mois plus anciens vs ${recentMonths.size} mois récents`;
  const max = Math.max(...rows.map(r => Math.max(r.older, r.recent)), 1);
  el.innerHTML = rows.map(r => {
    const arrow = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '·';
    const color = r.delta > 0 ? 'var(--accent)' : r.delta < 0 ? 'var(--text3)' : 'var(--text3)';
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
        <span style="color:var(--text2)">${esc(r.genre)}</span>
        <span style="font-family:var(--mono);color:${color}">${arrow} ${r.older.toLocaleString('fr-FR')} → ${r.recent.toLocaleString('fr-FR')}</span>
      </div>
      <div style="display:flex;gap:2px;height:8px">
        <div style="flex:1;background:var(--bg3);border-radius:2px;overflow:hidden"><div style="width:${(r.older/max*100).toFixed(1)}%;background:var(--text3);height:100%"></div></div>
        <div style="flex:1;background:var(--bg3);border-radius:2px;overflow:hidden"><div style="width:${(r.recent/max*100).toFixed(1)}%;background:var(--accent);height:100%"></div></div>
      </div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:12px;font-size:12px">Aucun genre identifié sur la période.</div>';
}

// ── Heatmap d'écoute (calendrier type GitHub, sur les scrobbles récents) ──────────────────
// Todo section 11, item ⬜ "Heatmap d'écoute (type calendrier GitHub) sur les scrobbles
// récents." Contrairement à l'évolution mensuelle ci-dessus (weekly charts, résolution
// hebdomadaire), une heatmap calendrier a besoin d'une résolution journalière — reconstituée ici
// depuis user.getrecenttracks (même endpoint que le panneau "Scrobbles récents"), filtré côté
// serveur last.fm via from= pour ne récupérer que les 90 derniers jours plutôt que de paginer sur
// tout l'historique. Résultat mis en cache (listeningHeatmap), jamais recalculé automatiquement.
const LISTENING_HEATMAP_DAYS = 90;

function renderListeningHeatmap() {
  const wrap = document.getElementById('ins-heatmap');
  const meta = document.getElementById('ins-heatmap-meta');
  if (!wrap) return;
  if (!listeningHeatmap.length) {
    wrap.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Pas encore calculée — clique sur "🔄 Charger la heatmap".</div>';
    if (meta) meta.textContent = '';
    return;
  }
  const byDate = {};
  listeningHeatmap.forEach(d => { byDate[d.date] = d.plays; });
  const max = Math.max(...listeningHeatmap.map(d => d.plays), 1);

  // Fenêtre de LISTENING_HEATMAP_DAYS jours se terminant aujourd'hui, étendue jusqu'au dimanche
  // précédent et au samedi de la semaine en cours pour obtenir des blocs de 7 jours complets
  // (rendu calendrier régulier type GitHub, colonnes = semaines). Les jours au-delà d'aujourd'hui
  // (fin de la dernière semaine) sont marqués `future` et rendus en cellule vide/invisible.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (LISTENING_HEATMAP_DAYS - 1));
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const days = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    const future = cursor > today;
    days.push({ date: iso, plays: future ? null : (byDate[iso] || 0) });
    cursor.setDate(cursor.getDate() + 1);
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const cellStyle = (d) => {
    if (d.plays === null) return 'background:transparent';
    if (!d.plays) return 'background:var(--bg3)';
    const ratio = Math.max(0.28, d.plays / max);
    return `background:var(--accent);opacity:${ratio.toFixed(2)}`;
  };
  const cellTitle = (d) => d.plays === null ? '' : `${d.date} : ${d.plays} écoute(s)`;

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(${weeks.length},11px);grid-template-rows:repeat(7,11px);grid-auto-flow:column;gap:2px">
      ${weeks.map(week => week.map(d => `<div style="width:11px;height:11px;border-radius:2px;${cellStyle(d)}" title="${escAttr(cellTitle(d))}"></div>`).join('')).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:6px">
      <span>${start.toISOString().slice(0, 10)}</span><span>${today.toISOString().slice(0, 10)}</span>
    </div>`;
  if (meta) meta.textContent = _listeningHeatmapComputedAt ? `Calculé ${formatProvenanceAge(_listeningHeatmapComputedAt)}` : '';
}

async function loadListeningHeatmap() {
  if (!_lastfmUser || !_lastfmApiKey) { toast('Configure last.fm dans Import / Export d\'abord', 'warn'); return; }
  const btn = document.getElementById('ins-heatmap-btn');
  const meta = document.getElementById('ins-heatmap-meta');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Chargement…'; }
  try {
    const cutoffTs = Math.floor(Date.now() / 1000) - LISTENING_HEATMAP_DAYS * 86400;
    const dayTotals = {};
    let page = 1;
    let totalPages = 1;
    // Garde-fou de pagination : from= filtre déjà côté serveur last.fm aux 90 derniers jours, donc
    // le nombre de pages attendu reste modeste sauf usage extrême (>200 écoutes/jour en moyenne
    // sur 90 jours) ; plafond défensif pour ne jamais boucler indéfiniment en cas de réponse
    // anormale de l'API, avec dégradation gracieuse (heatmap partielle plutôt que blocage).
    const MAX_PAGES = 60;
    while (page <= totalPages && page <= MAX_PAGES) {
      if (meta) meta.textContent = `Page ${page}…`;
      const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=200&page=${page}&from=${cutoffTs}&extended=0`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.message || String(data.error));
      totalPages = parseInt(data.recenttracks?.['@attr']?.totalPages || 1);
      const rawTracks = data.recenttracks?.track || [];
      rawTracks.forEach(t => {
        if (t['@attr']?.nowplaying) return;
        const ts = parseInt(t.date?.uts || 0);
        if (!ts || ts < cutoffTs) return;
        const day = new Date(ts * 1000).toISOString().slice(0, 10);
        dayTotals[day] = (dayTotals[day] || 0) + 1;
      });
      page++;
      if (page % 6 === 0) await new Promise(r => setTimeout(r, 200)); // pause légère tous les 6 appels
    }
    listeningHeatmap = Object.entries(dayTotals)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, plays]) => ({ date, plays }));
    _listeningHeatmapComputedAt = new Date().toISOString();
    saveToStorage();
    renderListeningHeatmap();
    toast('Heatmap d\'écoute chargée');
  } catch (e) {
    console.error('loadListeningHeatmap:', e.message || e);
    toast('Erreur last.fm : ' + (e.message || e), 'warn');
    if (meta) meta.textContent = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Charger la heatmap (90 derniers jours)'; }
  }
}

// ===================== YOUTUBE MUSIC (recherche simple, sans API) =====================
// Pas de clé API nécessaire : music.youtube.com/search accepte une requête texte en query
// param et fonctionne sans connexion pour parcourir/écouter (contrairement à Qobuz qui a posé
// des problèmes récurrents : changement de domaine, résultats vides même après nettoyage
// de la requête — remplacé le 06/07/2026 à la demande d'Antoine).
function cleanForStreamingSearch(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*[\(\[](feat\.?|ft\.?|featuring|live|radio\s*edit|single\s*edit|remaster(?:ed)?|bonus\s*track|demo|instrumental|acoustic|extended|album\s*version|original\s*mix)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .replace(/\s*[\(\[]\d{4}[\)\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function openYouTubeMusicSearch(artist, titleOrAlbum) {
  const cleanArtist = cleanForStreamingSearch(cleanDiscogsArtist(artist));
  const cleanTitle  = cleanForStreamingSearch(titleOrAlbum);
  const q = `${cleanArtist} ${cleanTitle}`.trim();
  window.open(`https://music.youtube.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
}

// Ouvrir YouTube Music pour un album : priorité au lien direct MusicBrainz (relation
// "free streaming"/"stream for free" posée par un éditeur MB vers youtube.com sur la
// release, récupérée via fetchMusicBrainzRelease), sinon repli sur la recherche ci-dessus.
function openYouTubeMusicForAlbum(album) {
  if (album?.youtube_url) {
    window.open(album.youtube_url, '_blank', 'noopener');
  } else {
    openYouTubeMusicSearch(album?.artist || '', album?.album || '');
  }
}

function openYouTubeMusicForAlbumId(id) {
  const realId = unsid(id);
  const a = albums.find(x => x.id === realId || x.id === String(realId));
  if (a) openYouTubeMusicForAlbum(a);
}

// ── Repli à la demande pour les MORCEAUX (todo section 8, dernier item ⬜) ──────────────
// Récupère le lien direct YouTube au niveau recording MusicBrainz (relation "free streaming"
// posée sur CE morceau précis, plus fiable qu'une recherche texte) via l'Edge Function.
// Appelé UNIQUEMENT au clic — jamais en pré-fetch de masse, voir trackYoutubeCache ci-dessus.
async function fetchMusicBrainzRecordingYoutube(recordingId) {
  const data = await callEdgeFn({ source: 'musicbrainz', recording_id: recordingId });
  return data.youtube_url || '';
}

// Point d'entrée unique pour "écouter ce morceau" (bouton ▶️), qu'il s'agisse d'un morceau
// isolé ou d'une piste de tracklist d'album — les deux portent un mb_recording_id (import XML
// MusicBee) une fois associés à MusicBrainz. Sans mb_recording_id, ou en cas d'échec/absence
// de lien direct, repli silencieux et immédiat sur la recherche YouTube Music existante.
async function listenToTrackByRecording(artist, title, mbRecordingId) {
  if (!mbRecordingId) { openYouTubeMusicSearch(artist, title); return; }
  if (Object.prototype.hasOwnProperty.call(trackYoutubeCache, mbRecordingId)) {
    const cached = trackYoutubeCache[mbRecordingId];
    if (cached) window.open(cached, '_blank', 'noopener');
    else openYouTubeMusicSearch(artist, title);
    return;
  }
  toast('Recherche du lien direct MusicBrainz…', 'info');
  try {
    const url = await fetchMusicBrainzRecordingYoutube(mbRecordingId);
    trackYoutubeCache[mbRecordingId] = url; // '' mis en cache aussi : évite de re-chercher à chaque écoute
    saveToStorage();
    if (url) window.open(url, '_blank', 'noopener');
    else openYouTubeMusicSearch(artist, title);
  } catch(e) {
    console.error('listenToTrackByRecording:', e.message || e);
    openYouTubeMusicSearch(artist, title); // repli silencieux, ne bloque jamais l'écoute
  }
}

// Wrapper pour un morceau isolé (tracks[]), utilisé par le bouton ▶️ de "Morceaux isolés".
// id reçu encodé via sid() — l'id d'un morceau isolé est "artistNorm|||titleNorm" (texte,
// contient espaces/pipes), jamais sûr à interpoler brut dans un attribut onclick.
function listenToIsolatedTrack(encodedId) {
  const id = unsid(encodedId);
  const t = tracks.find(x => x.id === id);
  if (t) listenToTrackByRecording(t.artist, t.title, t.mb_recording_id);
}

// Wrapper pour une piste de tracklist d'album, utilisé par le bouton ▶️ du panneau tracklist
// (fiche album + panneau embarqué Session notation). L'artiste vient de l'album (les lignes
// album_tracks ne portent pas leur propre artiste). Paramètres encodés via sid() (titre et
// mb_recording_id peuvent contenir des caractères non sûrs dans un attribut onclick brut).
function listenToAlbumTrack(encodedAlbumId, encodedTitle, encodedMbId) {
  const albumId = unsid(encodedAlbumId);
  const title = unsid(encodedTitle);
  const mbRecordingId = unsid(encodedMbId) || '';
  const album = albums.find(x => String(x.id) === String(albumId));
  listenToTrackByRecording(album?.artist || '', title, mbRecordingId);
}

// ===================== SESSION DE NOTATION =====================
// Écran dédié : un album ou un morceau isolé non noté à la fois (grosse pochette/avatar,
// étoiles, raccourcis clavier), plutôt que de chasser les lignes vides dans un tableau de
// 2500+ entrées. Deux files séparées (albums / morceaux isolés), chacune priorisée par
// écoutes last.fm décroissantes (le plus écouté et jamais noté remonte en premier).
let ratingSessionMode = 'albums'; // 'albums' | 'tracks' | 'scrobbles'
let ratingQueueTracks = [];

// Todo-adjacent (demandé par Antoine, session du 12/07/2026) : ordre aléatoire complet plutôt
// que trié par écoutes décroissantes — l'ancien tri reléguait structurellement les albums/
// morceaux jamais écoutés (0 écoute) en toute fin de file, ils n'étaient donc quasiment jamais
// proposés à la notation. "Prochain à écouter" (onglet séparé, suggestion pondérée note RYM +
// wishlist) est supprimé à la demande d'Antoine : son rôle de surfacer les albums possédés
// jamais écoutés est repris ici par le simple fait qu'ils ont maintenant une chance égale à
// tous les autres de sortir en premier (ils étaient déjà dans cette file avant, comme tout
// album non noté — seul le tri les enterrait). La wishlist n'a jamais fait partie de cette
// file et n'y entre toujours pas (Session notation ne note que des éléments POSSÉDÉS).
function buildRatingQueue() {
  return shuffleArray(
    ownedAlbumsForCovers().filter(a => !a.note).map(a => a.id)
  );
}

function buildRatingQueueTracks() {
  return shuffleArray(
    tracks.filter(t => !t.note).map(t => t.id)
  );
}

// Note actuelle d'une piste d'album (override utilisateur sinon note MusicBee/Discogs importée) —
// utilisée par le panneau tracklist embarqué dans le mode Albums, et par la notation depuis les
// Scrobbles récents.
function getAlbumTrackRating(albumId, title) {
  const key = trackNoteKey(albumId, title);
  if (Object.prototype.hasOwnProperty.call(trackNoteOverrides, key)) return trackNoteOverrides[key];
  const atracks = albumTracksCache[albumId] || [];
  const mbT = atracks.find(t => t.source === 'musicbee' && t.title === title);
  if (mbT) return mbT.rating || 0;
  const dT = atracks.find(t => t.source === 'discogs' && t.title === title);
  return dT?.rating || 0;
}

// ===================== ARTISTES SIMILAIRES (crédits MusicBrainz croisés) =====================
// Todo section 11, item ⬜ « Artistes similaires possédés via artist-rels MusicBrainz (déjà
// récupéré pour les crédits, v2026.07.10-11) : relie entre eux des artistes déjà présents dans
// la collection. » Réutilise album.mb_credits (relations artiste posées au niveau release —
// producteur, remix, featuring, membre…, cf. renderMbCreditsPanel) sans aucun appel API
// supplémentaire : pour chaque crédit d'un album, si le nom crédité correspond (via
// artistVariants(), même mécanisme de normalisation que le matching last.fm) à un artiste déjà
// présent ailleurs dans la collection, c'est une connexion. Volontairement pas de vraies
// "similar artists" (ça nécessiterait l'API last.fm/MB dédiée, hors scope ici) : ce sont des
// collaborations réelles et vérifiables entre artistes que tu possèdes déjà.
function buildOwnedArtistIndex() {
  const idx = new Map(); // normKey -> Set(nom d'artiste tel qu'affiché dans la collection)
  ownedAlbumsForCovers().forEach(a => {
    if (!a.artist) return;
    artistVariants(a.artist).forEach(v => {
      if (!idx.has(v)) idx.set(v, new Set());
      idx.get(v).add(a.artist);
    });
  });
  return idx;
}

function computeArtistConnections() {
  const idx = buildOwnedArtistIndex();
  const connections = [];
  const seen = new Set(); // dédoublonnage : mêmeArtiste|artisteConnecté|rôle|album
  ownedAlbumsForCovers().forEach(a => {
    const credits = a.mb_credits || [];
    if (!credits.length || !a.artist) return;
    const fromVariants = artistVariants(a.artist);
    credits.forEach(c => {
      if (!c.name || !c.role) return;
      artistVariants(c.name).forEach(v => {
        if (fromVariants.has(v)) return; // le crédit désigne l'artiste principal lui-même — pas une connexion
        const owners = idx.get(v);
        if (!owners) return;
        owners.forEach(toArtist => {
          const key = `${normalizeKey(a.artist,'')}|${normalizeKey(toArtist,'')}|${c.role}|${a.id}`;
          if (seen.has(key)) return;
          seen.add(key);
          connections.push({ fromArtist: a.artist, toArtist, role: c.role, albumId: a.id, album: a.album });
        });
      });
    });
  });
  return connections;
}

function renderArtistLinks() {
  const q = (document.getElementById('artistlinks-search')?.value || '').toLowerCase().trim();
  let list = computeArtistConnections();
  if (q) list = list.filter(c => c.fromArtist.toLowerCase().includes(q) || c.toArtist.toLowerCase().includes(q));
  list.sort((x, y) => x.fromArtist.localeCompare(y.fromArtist) || x.toArtist.localeCompare(y.toArtist));

  const distinctArtists = new Set();
  list.forEach(c => { distinctArtists.add(normalizeKey(c.fromArtist,'')); distinctArtists.add(normalizeKey(c.toArtist,'')); });
  const counter = document.getElementById('artistlinks-counter');
  if (counter) counter.textContent = `${list.length} connexion(s) entre ${distinctArtists.size} artiste(s) de ta collection`;

  const tbody = document.getElementById('artistlinks-tbody');
  if (!tbody) return;
  tbody.innerHTML = list.map(c => {
    const label = MB_CREDIT_ROLE_LABELS[c.role] || (c.role.charAt(0).toUpperCase() + c.role.slice(1));
    return `<tr>
      <td style="font-weight:500">${artistLink(c.fromArtist)}</td>
      <td style="font-weight:500">${artistLink(c.toArtist)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(label)}</td>
      <td onclick="editAlbum('${sid(c.albumId)}')" style="cursor:pointer;font-size:12px;color:var(--text3)">${esc(c.album)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty" style="padding:24px"><div class="empty-icon">🕸️</div>${q ? 'Aucune connexion pour ce filtre.' : "Aucune connexion trouvée — les crédits MusicBrainz ne sont récupérés qu'au fetch/rafraîchissement d'un album lié (fiche album, bouton 🔄 Rafraîchir depuis la source)."}</div></td></tr>`;
}

// ===================== VALEUR COLLECTION (stats marketplace Discogs) =====================
// Todo section 11, item ⬜ « Suivi de valeur collection : prix marketplace Discogs (endpoint
// stats, discogsId déjà présent) pour une estimation globale (assurance). » Endpoint séparé de
// la fiche release (/marketplace/stats/{id}, pas inclus dans /releases/{id}) — nécessite le
// même token Discogs que les autres appels Discogs de l'app, donc passe par l'Edge Function
// get-release-info.ts (nouvelle branche "discogs_stats", jamais en direct depuis le navigateur :
// CORS + auth serveur, comme tous les autres appels Discogs existants). Périmètre : CD
// catalogués (a.cd && a.discogsId) uniquement — le numérique n'a pas de valeur marketplace
// Discogs. Récupération en masse À LA DEMANDE (bouton dédié, jamais automatique), pacée à 700ms
// entre requêtes (même cadence que fetchAllTracklists pour l'Edge Function Discogs), sur tout le
// périmètre restant à estimer en un seul clic — cohérent avec le seul autre gros fetch Discogs
// de l'app plutôt que de fragmenter en lots multi-clics.
function marketValueEligibleAlbums() {
  return albums.filter(a => a.cd && a.discogsId);
}

// ===================== PRÊTS EN COURS =====================
// Champ purement local à l'app (loaned_to/loaned_since sur l'album) — aucune source externe
// (MusicBee/Discogs/RYM) ne connaît la notion de prêt, donc pas de détection auto de retour
// comme pour "Notes à reporter" : le retrait se fait uniquement via markLoanReturned().
function renderLoans() {
  const loaned = albums.filter(a => a.loaned_to).sort((a, b) => (a.loaned_since || '9999') < (b.loaned_since || '9999') ? -1 : 1);
  const tbody = document.getElementById('loans-tbody');
  if (!tbody) return;
  if (!loaned.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📤</div>Aucun prêt en cours.</div></td></tr>';
    return;
  }
  tbody.innerHTML = loaned.map(a => {
    const days = a.loaned_since ? Math.floor((Date.now() - new Date(a.loaned_since).getTime()) / 86400000) : null;
    const sinceLabel = a.loaned_since ? `${a.loaned_since}${days != null && days >= 0 ? ` (${days} j)` : ''}` : '–';
    return `<tr>
      <td>${esc(a.artist)}</td>
      <td style="cursor:pointer;color:var(--accent)" onclick="editAlbum('${sid(a.id)}')">${esc(a.album)}</td>
      <td>${esc(a.loaned_to)}</td>
      <td class="mono">${sinceLabel}</td>
      <td><button class="btn btn-sm" onclick="markLoanReturned('${sid(a.id)}')" title="Vide les champs prêt et sauvegarde immédiatement">↩ Rendu</button></td>
    </tr>`;
  }).join('');
}

// Contrairement à clearLoanFields() (modale, pas encore sauvegardé), ici la mutation est
// immédiate + sauvegardée — utilisé depuis le tableau "Prêts en cours" où il n'y a pas de
// bouton "Enregistrer" séparé.
function markLoanReturned(idSid) {
  const id = unsid(idSid);
  const a = albums.find(x => x.id === id || x.id === String(id));
  if (!a) return;
  a.loaned_to = undefined;
  a.loaned_since = undefined;
  saveToStorage();
  renderLoans();
  updateNavBadges();
  toast(`${a.artist} — ${a.album} marqué comme rendu`);
}

function renderMarketValue() {
  const eligible = marketValueEligibleAlbums();
  const estimated = eligible.filter(a => a.marketplace_price != null);
  const pending = eligible.length - estimated.length;
  const total = estimated.reduce((sum, a) => sum + (a.marketplace_price || 0), 0);
  const avg = estimated.length ? total / estimated.length : 0;
  const currency = estimated[0]?.marketplace_currency || 'EUR';

  const fmtMoney = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (currency === 'EUR' ? '€' : currency);

  document.getElementById('mv-total').textContent = estimated.length ? fmtMoney(total) : '–';
  document.getElementById('mv-estimated').textContent = `${estimated.length} / ${eligible.length}`;
  document.getElementById('mv-pending').textContent = pending;
  document.getElementById('mv-avg').textContent = estimated.length ? fmtMoney(avg) : '–';

  recordMarketValueSnapshot();
  renderMarketValueHistory();

  const tbody = document.getElementById('mv-tbody');
  if (!tbody) return;
  const sorted = [...estimated].sort((a, b) => (b.marketplace_price || 0) - (a.marketplace_price || 0));
  tbody.innerHTML = sorted.map(a => {
    const price = fmtMoney(a.marketplace_price || 0);
    const age = a.marketplace_fetched_at ? formatProvenanceAge(a.marketplace_fetched_at) : '–';
    return `<tr onclick="editAlbum('${sid(a.id)}')" style="cursor:pointer">
      <td><div style="font-weight:500">${esc(a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(a.artist)}</div></td>
      <td class="mono" style="text-align:right;color:var(--accent)">${price}</td>
      <td class="mono" style="text-align:right;color:var(--text3)">${a.marketplace_num_for_sale ?? '–'}</td>
      <td style="font-size:11px;color:var(--text3)">${age}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty" style="padding:24px"><div class="empty-icon">💰</div>${eligible.length ? 'Aucun prix récupéré pour l\'instant — clique sur "🔄 Estimer les prix manquants".' : 'Aucun CD catalogué Discogs dans la collection.'}</div></td></tr>`;
}

// Todo section 11, item ⬜ « Valeur collection est un instantané figé — conserver un point de
// valeur par mois donnerait une vraie courbe d'évolution ». Photo des prix déjà estimés
// (aucun appel réseau), capturée à chaque visite de cet onglet — un seul point par mois,
// écrase le point du mois en cours s'il existe déjà (pas besoin de plus qu'un point/mois).
// Ne fait rien tant qu'aucun prix n'a jamais été estimé (évite un point à 0€ trompeur).
function recordMarketValueSnapshot() {
  const estimated = marketValueEligibleAlbums().filter(a => a.marketplace_price != null);
  if (!estimated.length) return;
  const total = estimated.reduce((s, a) => s + (a.marketplace_price || 0), 0);
  const currency = estimated[0]?.marketplace_currency || 'EUR';
  const month = new Date().toISOString().slice(0, 7);
  const existing = marketValueHistory.find(p => p.month === month);
  if (existing) {
    if (existing.total === total && existing.count === estimated.length) return; // rien de neuf, pas de save inutile
    existing.total = total; existing.count = estimated.length; existing.currency = currency;
  } else {
    marketValueHistory.push({ month, total, count: estimated.length, currency });
    marketValueHistory.sort((a, b) => a.month.localeCompare(b.month));
  }
  saveToStorage();
}

function renderMarketValueHistory() {
  const el = document.getElementById('mv-history');
  if (!el) return;
  if (marketValueHistory.length < 2) {
    el.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Encore trop peu de points pour une courbe — 1 point par mois, capturé automatiquement à chaque visite de cet onglet. Reviens dans quelques semaines.</div>';
    return;
  }
  const fmtMoney = (v, currency) => v.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ' + (currency === 'EUR' ? '€' : currency);
  const max = Math.max(...marketValueHistory.map(p => p.total), 1);
  el.innerHTML = `<div style="display:flex;align-items:flex-end;gap:4px;height:110px">` +
    marketValueHistory.map(p => `
      <div style="flex:1;display:flex;align-items:flex-end;height:100%" title="${p.month} : ${fmtMoney(p.total, p.currency)} (${p.count} CD estimés)">
        <div style="width:100%;background:var(--accent);border-radius:2px 2px 0 0;height:${Math.max(2, p.total / max * 100).toFixed(1)}%"></div>
      </div>`).join('') +
    `</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:4px">
      <span>${marketValueHistory[0].month}</span><span>${marketValueHistory[marketValueHistory.length - 1].month}</span>
    </div>`;
}

async function fetchAllMarketplaceStats() {
  const btn = document.getElementById('mv-fetch-btn');
  const status = document.getElementById('mv-fetch-status');
  const targets = marketValueEligibleAlbums().filter(a => a.marketplace_price == null);
  if (!targets.length) {
    if (status) status.textContent = 'Tous les CD catalogués sont déjà estimés.';
    return;
  }
  if (btn) btn.disabled = true;
  let done = 0, errors = 0;
  for (const a of targets) {
    if (status) status.textContent = `${done}/${targets.length} — ${a.artist} — ${a.album}`;
    try {
      await new Promise(r => setTimeout(r, 700)); // Edge Fn rate limit Discogs (même cadence que fetchAllTracklists)
      const stats = await fetchMarketplaceStats(a.discogsId);
      a.marketplace_price = stats.price;
      a.marketplace_currency = stats.currency;
      a.marketplace_num_for_sale = stats.numForSale;
      a.marketplace_fetched_at = new Date().toISOString();
    } catch (e) {
      console.warn('fetchAllMarketplaceStats:', a.artist, '—', a.album, e.message || e);
      errors++;
    }
    done++;
    if (done % 10 === 0) { renderMarketValue(); saveToStorage(); }
  }
  renderMarketValue();
  saveToStorage();
  if (status) status.textContent = `Terminé — ${done - errors} estimé(s)${errors ? `, ${errors} erreur(s)` : ''}.`;
  if (btn) btn.disabled = false;
  toast(`Estimation terminée : ${done - errors}/${targets.length} CD`);
}

// ===================== SCROBBLES RÉCENTS (Session notation) =====================
// Lecture live de l'API last.fm (user.getrecenttracks) — volontairement non persistée : la sync
// habituelle n'agrège que des compteurs (lastfmData/_lastfmTrackCounts), jamais l'horodatage par
// scrobble individuel, donc impossible de reconstituer un historique chronologique depuis les
// données déjà stockées. Chaque ouverture/actualisation refait un appel direct à l'API.
let scrobblesViewMode = 'albums'; // 'albums' | 'tracks'
let _scrobblesRaw = []; // [{ artist, title, album, ts }] — ordre = plus récent en premier (ordre natif de l'API)
let _scrobblesPage = 1;
let _scrobblesTotalPages = 1;
let _scrobblesLoading = false;

function setScrobblesViewMode(mode) {
  scrobblesViewMode = mode;
  const btnA = document.getElementById('rs-scrobbles-view-albums');
  const btnT = document.getElementById('rs-scrobbles-view-tracks');
  if (btnA) btnA.classList.toggle('active', mode === 'albums');
  if (btnT) btnT.classList.toggle('active', mode === 'tracks');
  renderScrobblesList();
}

async function loadRecentScrobbles(reset) {
  if (_scrobblesLoading) return;
  if (!_lastfmApiKey || !_lastfmUser) {
    const st = document.getElementById('rs-scrobbles-status');
    if (st) st.textContent = 'Identifiants last.fm non configurés (Import/Export).';
    return;
  }
  _scrobblesLoading = true;
  if (reset) { _scrobblesRaw = []; _scrobblesPage = 1; _scrobblesTotalPages = 1; }
  const btn = document.getElementById('rs-scrobbles-refresh-btn');
  const moreBtn = document.getElementById('rs-scrobbles-more-btn');
  const status = document.getElementById('rs-scrobbles-status');
  if (btn) btn.disabled = true;
  if (moreBtn) moreBtn.disabled = true;
  if (status) status.textContent = 'Chargement…';

  try {
    const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(_lastfmUser)}&api_key=${_lastfmApiKey}&format=json&limit=200&page=${_scrobblesPage}&extended=0`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      if (status) status.textContent = `Erreur last.fm : ${data.message || data.error}`;
      return;
    }
    const rawTracks = data.recenttracks?.track || [];
    _scrobblesTotalPages = parseInt(data.recenttracks?.['@attr']?.totalPages || 1);
    rawTracks.forEach(t => {
      if (t['@attr']?.nowplaying) return;
      const artist = String(t.artist?.['#text'] || t.artist?.name || t.artist || '').trim();
      const title  = String(t.name || '').trim();
      const album  = String(t.album?.['#text'] || t.album?.name || (typeof t.album === 'string' ? t.album : '') || '').trim();
      const ts = parseInt(t.date?.uts || 0);
      if (!artist || !title) return;
      _scrobblesRaw.push({ artist, title, album, ts });
    });
    if (status) status.textContent = `${_scrobblesRaw.length} scrobble(s) chargé(s) — page ${_scrobblesPage} / ${_scrobblesTotalPages}`;
    if (moreBtn) moreBtn.style.display = _scrobblesPage < _scrobblesTotalPages ? 'inline-block' : 'none';
    _scrobblesPage++;
    renderScrobblesList();
  } catch (e) {
    if (status) status.textContent = `Erreur réseau : ${e.message}`;
  } finally {
    _scrobblesLoading = false;
    if (btn) btn.disabled = false;
    if (moreBtn) moreBtn.disabled = false;
  }
}

function fmtScrobbleDate(ts) {
  if (!ts) return '–';
  return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function noteCellHtml(value) {
  return value
    ? `<span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${Number(value).toFixed(1)}<span style="font-size:10px;opacity:0.7">★</span></span>`
    : `<span style="color:var(--text3);font-size:11px">–</span>`;
}

function renderScrobblesList() {
  const thead = document.getElementById('rs-scrobbles-thead');
  const tbody = document.getElementById('rs-scrobbles-tbody');
  if (!thead || !tbody) return;

  if (scrobblesViewMode === 'tracks') {
    thead.innerHTML = '<tr><th>Titre</th><th>Artiste</th><th>Album</th><th style="width:150px">Écouté le</th><th style="width:60px">Note</th></tr>';
    if (!_scrobblesRaw.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">🕐</div>Aucun scrobble chargé</div></td></tr>';
      return;
    }
    // La cellule Note n'est cliquable que s'il existe une correspondance réelle dans la collection
    // (morceau isolé ou piste d'un album possédé) : noter un scrobble qui ne matche rien n'a pas
    // de destination utile et n'était donc jamais reporté nulle part.
    tbody.innerHTML = _scrobblesRaw.map(s => {
      const matched = !!_scrobbleTrackMatch(s.artist, s.title);
      const noteCell = matched
        ? `<td onclick="rateScrobbleTrack('${sid(s.artist)}','${sid(s.title)}')" title="Noter ce morceau" style="cursor:pointer">${noteCellHtml(_scrobbleTrackCurrentNote(s.artist, s.title))}</td>`
        : `<td title="Aucune correspondance dans la collection — impossible de noter" style="cursor:not-allowed;opacity:0.4">${noteCellHtml(0)}</td>`;
      return `<tr>
      <td style="font-weight:500">${esc(s.title)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(s.artist)}</td>
      <td style="font-size:12px;color:var(--text3)">${esc(s.album || '–')}</td>
      <td class="mono" style="font-size:11px;color:var(--text3)">${fmtScrobbleDate(s.ts)}</td>
      ${noteCell}
    </tr>`;
    }).join('');
  } else {
    // Vue Albums : dédoublonnée en conservant l'ordre d'apparition (donc le scrobble le plus
    // récent) de chaque couple artiste/album — reconstitue une liste d'albums récemment écoutés.
    // Colonne RYM ajoutée à côté de Note : la notation d'un album depuis ce panneau sert avant
    // tout à alimenter RYM (via "Notes à reporter"), donc on affiche la note RYM existante (si
    // déjà connue) pour éviter de re-noter un album déjà noté côté RYM.
    thead.innerHTML = '<tr><th>Album</th><th>Artiste</th><th style="width:150px">Dernière écoute</th><th style="width:60px">RYM</th><th style="width:60px">Note</th></tr>';
    const seen = new Set();
    const albumsList = [];
    _scrobblesRaw.forEach(s => {
      if (!s.album) return;
      const key = normalizeKey(s.artist, s.album);
      if (seen.has(key)) return;
      seen.add(key);
      albumsList.push(s);
    });
    if (!albumsList.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">🕐</div>Aucun scrobble chargé</div></td></tr>';
      return;
    }
    tbody.innerHTML = albumsList.map(s => {
      const rymEntry = lookupRym(s.artist, s.album) || lookupRym(cleanDiscogsArtist(s.artist), s.album);
      return `<tr>
      <td style="font-weight:500">${esc(s.album)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(s.artist)}</td>
      <td class="mono" style="font-size:11px;color:var(--text3)">${fmtScrobbleDate(s.ts)}</td>
      <td class="mono" style="font-size:11px;color:var(--amber)">${rymEntry?.rating ? rymEntry.rating.toFixed(2) + '★' : '<span style="color:var(--text3)">–</span>'}</td>
      <td onclick="rateScrobbleAlbum('${sid(s.artist)}','${sid(s.album)}')" title="Noter cet album" style="cursor:pointer">${noteCellHtml(_scrobbleAlbumCurrentNote(s.artist, s.album))}</td>
    </tr>`;
    }).join('');
  }
}

// Note actuelle d'un scrobble album/morceau — cherche d'abord dans la collection possédée
// (album.note, morceau isolé, ou piste d'album via trackNoteOverrides), sinon 0 (rien connu).
function _scrobbleAlbumCurrentNote(artist, album) {
  const key = normalizeKey(artist, album);
  const owned = albums.find(a => normalizeKey(a.artist, a.album) === key);
  return owned?.note || 0;
}

// Cherche une correspondance réelle dans la collection pour un scrobble morceau (isolé ou piste
// d'un album possédé, tout le catalogue de tracklists confondu). Noter un scrobble n'a de sens
// que s'il y a une telle correspondance — sinon la note ne rejoindra jamais aucune fiche réelle.
function _scrobbleTrackMatch(artist, title) {
  const key = normalizeKey(artist, title);
  const iso = tracks.find(t => normalizeKey(t.artist, t.title) === key);
  if (iso) return { type: 'isolated', track: iso };
  for (const a of albums) {
    const atracks = albumTracksCache[a.id] || [];
    const t = atracks.find(tt => normalizeKey(a.artist, tt.title) === key);
    if (t) return { type: 'albumtrack', album: a, title: t.title };
  }
  return null;
}

function _scrobbleTrackCurrentNote(artist, title) {
  const m = _scrobbleTrackMatch(artist, title);
  if (!m) return 0;
  if (m.type === 'isolated') return m.track.note || 0;
  return getAlbumTrackRating(m.album.id, m.title);
}

// Notation depuis le panneau Scrobbles récents — via prompt() comme les autres notes rapides de
// l'app (promptStockRating/promptDiscogsRating). Le scrobble n'est pas forcément dans la
// collection : si un album/morceau possédé correspond, sa note est mise à jour normalement ; sinon
// la note est quand même envoyée dans "📋 Notes à reporter" pour ne pas la perdre, avec un avertissement.
function rateScrobbleAlbum(artistSid, albumSid) {
  const artist = unsid(artistSid), album = unsid(albumSid);
  const key = normalizeKey(artist, album);
  const owned = albums.find(a => normalizeKey(a.artist, a.album) === key);
  const raw = prompt(`Note pour "${album}" — ${artist} (0 à 5, demi-étoiles possibles) :`, owned?.note || '');
  if (raw === null) return;
  const trimmed = raw.trim().replace(',', '.');
  let note = 0;
  if (trimmed !== '') {
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)', 'warn'); return; }
    note = Math.round(n * 2) / 2;
  }
  if (owned) {
    owned.note = note;
    queueNoteToReport('album', owned, note);
    invalidateCache();
    renderAlbums();
    toast(`${owned.artist} — ${owned.album} noté ${note}★`);
  } else {
    queueNoteToReport('album', { artist, album }, note);
    toast(`Pas dans la collection — note ajoutée à "Notes à reporter" pour ${artist} — ${album}`, 'warn');
  }
  saveToStorage();
  updateNavBadges();
  renderScrobblesList();
}

function rateScrobbleTrack(artistSid, titleSid) {
  const artist = unsid(artistSid), title = unsid(titleSid);
  const match = _scrobbleTrackMatch(artist, title);
  if (!match) {
    // Filet de sécurité : la cellule Note n'est normalement pas cliquable dans ce cas (voir
    // renderScrobblesList), mais on protège aussi la fonction elle-même.
    toast(`Aucune correspondance dans la collection pour "${title}" — ${artist}, impossible de noter`, 'warn');
    return;
  }
  const current = match.type === 'isolated' ? (match.track.note || 0) : getAlbumTrackRating(match.album.id, match.title);
  const raw = prompt(`Note pour "${title}" — ${artist} (0 à 5, demi-étoiles possibles) :`, current || '');
  if (raw === null) return;
  const trimmed = raw.trim().replace(',', '.');
  let note = 0;
  if (trimmed !== '') {
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)', 'warn'); return; }
    note = Math.round(n * 2) / 2;
  }
  if (match.type === 'isolated') {
    match.track.note = note;
    queueNoteToReport('track', match.track, note);
    toast(`${match.track.title} noté ${note}★`);
  } else {
    const tkey = trackNoteKey(match.album.id, match.title);
    trackNoteOverrides[tkey] = note;
    invalidateCache();
    queueNoteToReport('track', { artist: match.album.artist, title: match.title }, note);
    toast(`${match.title} (${match.album.album}) noté ${note}★`);
  }
  saveToStorage();
  updateNavBadges();
  renderScrobblesList();
}

function initRatingSession() {
  ratingQueue = buildRatingQueue();
  ratingQueueTracks = buildRatingQueueTracks();
  renderRatingSession();
}

function setRatingSessionMode(mode) {
  ratingSessionMode = mode;
  const btnA = document.getElementById('rs-mode-btn-albums');
  const btnT = document.getElementById('rs-mode-btn-tracks');
  const btnS = document.getElementById('rs-mode-btn-scrobbles');
  if (btnA) btnA.classList.toggle('active', mode === 'albums');
  if (btnT) btnT.classList.toggle('active', mode === 'tracks');
  if (btnS) btnS.classList.toggle('active', mode === 'scrobbles');
  renderRatingSession();
}

function renderRatingSession() {
  const mode = ratingSessionMode;

  // Mode "Scrobbles récents" : panneau à part, pas de file de notation (lecture seule, live API)
  const progressWrapEl = document.getElementById('rs-progress-wrap');
  const scrobblesWrapEl = document.getElementById('rs-scrobbles-wrap');
  if (mode === 'scrobbles') {
    if (progressWrapEl) progressWrapEl.style.display = 'none';
    const emptyEl0 = document.getElementById('rs-empty');
    const cardEl0 = document.getElementById('rs-card-wrap');
    if (emptyEl0) emptyEl0.style.display = 'none';
    if (cardEl0) cardEl0.style.display = 'none';
    if (scrobblesWrapEl) scrobblesWrapEl.style.display = 'block';
    if (!_scrobblesRaw.length && !_scrobblesLoading) loadRecentScrobbles(true);
    else renderScrobblesList();
    return;
  }
  if (progressWrapEl) progressWrapEl.style.display = '';
  if (scrobblesWrapEl) scrobblesWrapEl.style.display = 'none';

  // Retirer des files les entrées notées/supprimées entretemps ailleurs dans l'app
  ratingQueue = ratingQueue.filter(id => {
    const a = albums.find(x => x.id === id);
    return a && !a.note;
  });
  ratingQueueTracks = ratingQueueTracks.filter(id => {
    const t = tracks.find(x => x.id === id);
    return t && !t.note;
  });

  const totalOwned = mode === 'tracks' ? tracks.length : ownedAlbumsForCovers().length;
  const ratedCount = mode === 'tracks' ? tracks.filter(t => t.note).length : ownedAlbumsForCovers().filter(a => a.note).length;
  const pct = totalOwned ? Math.round((ratedCount / totalOwned) * 100) : 0;
  const fillEl = document.getElementById('rs-progress-fill');
  const labelEl = document.getElementById('rs-progress-label');
  const labelWord = mode === 'tracks' ? 'morceaux notés' : 'albums notés';
  if (fillEl) fillEl.style.width = pct + '%';
  if (labelEl) labelEl.textContent = `${ratedCount} / ${totalOwned} ${labelWord}`;

  const queue = mode === 'tracks' ? ratingQueueTracks : ratingQueue;
  const emptyEl = document.getElementById('rs-empty');
  const cardEl = document.getElementById('rs-card-wrap');
  if (!queue.length) {
    if (emptyEl) {
      emptyEl.style.display = 'block';
      const msg = emptyEl.querySelector('div:last-child');
      if (msg) msg.textContent = mode === 'tracks' ? 'Tous les morceaux isolés sont notés !' : 'Tous les albums possédés sont notés !';
    }
    if (cardEl) cardEl.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (cardEl) cardEl.style.display = 'block';
  const noteInputEl = document.getElementById('rs-note-input');
  if (noteInputEl) noteInputEl.value = ''; // toujours vide au changement d'album/morceau courant

  const sugEl = document.getElementById('rs-rym-suggestion');
  const tracklistWrapEl = document.getElementById('rs-album-tracklist-wrap');

  if (mode === 'tracks') {
    const t = tracks.find(x => x.id === queue[0]);
    if (!t) { ratingQueueTracks.shift(); renderRatingSession(); return; }
    const lfExact = getLfExactMap();
    const plays = lfExact.get(normalizeKey(t.artist, t.title)) || 0;

    document.getElementById('rs-cover').innerHTML = initials(t.artist || '?');
    document.getElementById('rs-title').textContent = t.title;
    document.getElementById('rs-artist').textContent = t.artist;
    document.getElementById('rs-meta').textContent = [t.album, (t.format || '').toUpperCase()].filter(Boolean).join(' · ');
    document.getElementById('rs-plays').textContent = plays ? `${plays} écoute(s) last.fm` : 'Pas d’écoutes last.fm connues';
    if (sugEl) { sugEl.style.display = 'none'; sugEl.innerHTML = ''; }
    if (tracklistWrapEl) tracklistWrapEl.style.display = 'none';
    document.getElementById('rs-stars').innerHTML = [1, 2, 3, 4, 5].map(i => `<button class="star" onclick="rsRateCurrent(${i})" title="${i}★">★</button>`).join('');
  } else {
    const a = albums.find(x => x.id === queue[0]);
    if (!a) { ratingQueue.shift(); renderRatingSession(); return; }

    document.getElementById('rs-cover').innerHTML = albumAvatar(a);
    document.getElementById('rs-title').textContent = a.album;
    document.getElementById('rs-artist').textContent = a.artist;
    document.getElementById('rs-meta').textContent = [a.year, a.genre].filter(Boolean).join(' · ');
    document.getElementById('rs-plays').textContent = a.plays ? `${a.plays} écoute(s) last.fm` : 'Pas d’écoutes last.fm connues';

    // Suggestion RYM : point de départ affiché, jamais posée automatiquement à la place d'une note perso.
    // BUG CORRIGÉ (v2026.07.10-26) : a.id manquant ici empêchait lookupRym() de retomber sur une
    // association RYM manuelle (rymAssociations) quand le nom ne matche pas automatiquement (ex.
    // "V.V. Brown" côté RYM vs "VV Brown" côté collection) — la suggestion restait invisible même
    // après avoir associé manuellement l'album depuis l'écran RYM.
    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    if (sugEl) {
      if (rymEntry?.rating) {
        sugEl.style.display = 'block';
        sugEl.innerHTML = `<div style="font-size:12px;color:var(--amber);margin-bottom:10px">Suggestion RYM : ${rymEntry.rating.toFixed(2)}★ <span style="color:var(--text3)">(point de départ, jamais posée automatiquement)</span></div>`;
      } else {
        sugEl.style.display = 'none';
        sugEl.innerHTML = '';
      }
    }

    // Pistes de l'album, notables en demi-étoiles sans quitter la session (ex "Pistes d'albums")
    const hasTracklist = (albumTracksCache[a.id] || []).some(t => t.source === 'musicbee');
    if (tracklistWrapEl) tracklistWrapEl.style.display = hasTracklist ? 'block' : 'none';
    if (hasTracklist) renderAlbumTracklistPanel(a.id, 'rs-album-tracklist-list');

    // Notation album en demi-étoiles (comme les pistes), pas seulement des étoiles entières
    document.getElementById('rs-stars').innerHTML = bigHalfStarsHtml(a.note || 0);
  }
}

function rsRateCurrent(note) {
  if (ratingSessionMode === 'tracks') {
    const id = ratingQueueTracks[0];
    if (!id) return;
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    t.note = note;
    queueNoteToReport('track', t, note);
    saveToStorage();
    ratingQueueTracks.shift();
    toast(`${t.title} noté ${note}★`);
  } else {
    const id = ratingQueue[0];
    if (!id) return;
    const a = albums.find(x => x.id === id);
    if (!a) return;
    a.note = note;
    queueNoteToReport('album', a, note);
    saveToStorage();
    ratingQueue.shift();
    toast(`${a.album} noté ${note}★`);
  }
  renderRatingSession();
}

// Saisie numérique de la note (album ou morceau isolé courant) — alternative aux clics sur les
// étoiles pour contourner les extensions navigateur qui interceptent parfois le clic (voir note
// v2026.07.08-11/-14). Demi-étoiles acceptées (ex: "3.5" ou "3,5"), arrondi au 0.5 le plus proche.
function rsRateFromInput() {
  const inp = document.getElementById('rs-note-input');
  if (!inp) return;
  const raw = inp.value.trim().replace(',', '.');
  if (raw === '') { toast('Entre une note entre 0 et 5', 'warn'); return; }
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)', 'warn'); return; }
  rsRateCurrent(Math.round(n * 2) / 2);
}
(function() {
  const inp = document.getElementById('rs-note-input');
  if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); rsRateFromInput(); } });
})();

function rsSkipCurrent() {
  const queue = ratingSessionMode === 'tracks' ? ratingQueueTracks : ratingQueue;
  if (queue.length < 2) return;
  queue.push(queue.shift());
  renderRatingSession();
}

function rsListenCurrent() {
  if (ratingSessionMode === 'tracks') {
    const t = tracks.find(x => x.id === ratingQueueTracks[0]);
    if (t) listenToTrackByRecording(t.artist, t.title, t.mb_recording_id);
  } else {
    const a = albums.find(x => x.id === ratingQueue[0]);
    if (a) openYouTubeMusicForAlbum(a);
  }
}

// Raccourcis clavier (touches 1-5 pour noter, S pour passer) — actifs uniquement
// sur l'écran Session notation (albums ou morceaux) et hors saisie dans un champ.
document.addEventListener('keydown', (e) => {
  const sec = document.getElementById('sec-ratesession');
  if (!sec || !sec.classList.contains('active')) return;
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key >= '1' && e.key <= '5') { e.preventDefault(); rsRateCurrent(parseInt(e.key, 10)); }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); rsSkipCurrent(); }
});

// ===================== NOTES À REPORTER =====================
// L'app agrège MusicBee/Discogs/RYM mais n'y écrit jamais rien : une note posée dans l'app
// (ex: via la Session notation) doit être reportée manuellement dans ces sources réelles pour
// rester cohérente au fil des réimports. Cette file garde trace de ce qui reste à reporter,
// par cible. Discogs et RYM se cochent automatiquement dès qu'un réimport détecte la note côté
// source ; MusicBee n'a pas d'API locale détectable, donc se coche manuellement.
const NTR_TARGET_LABELS = { musicbee: 'MusicBee', discogs: 'Discogs', rym: 'RYM' };

function queueNoteToReport(type, entity, note) {
  const title = type === 'album' ? entity.album : entity.title;
  const key = normalizeKey(entity.artist, title);
  let targets = [];
  // MusicBee n'est une cible pertinente QUE si l'album a effectivement une tracklist MusicBee
  // (fichiers réellement présents dans la bibliothèque MusicBee) — sinon il n'y a tout
  // simplement rien à reporter là-bas (cas des albums notés via RYM/Stock/Session notation mais
  // jamais destinés à rejoindre la collection MusicBee). Pour les morceaux isolés (type
  // 'track'), MusicBee reste la seule cible possible (RYM ne note pas au niveau morceau) — pas
  // de vérification de présence ici, comportement inchangé.
  const hasMusicBeeFile = type === 'album'
    ? (albumTracksCache[entity.id] || []).some(t => t.source === 'musicbee')
    : true;
  if (hasMusicBeeFile) targets.push('musicbee');
  if (type === 'album') {
    if (entity.discogsId && !entity.discogsRating) targets.push('discogs');
    const rymEntry = lookupRym(entity.artist, entity.album, entity.id) || lookupRym(cleanDiscogsArtist(entity.artist), entity.album, entity.id);
    if (!rymEntry?.rating) targets.push('rym');
  }
  // Une nouvelle note sur la même fiche remplace l'entrée en attente précédente
  notesToReport = notesToReport.filter(e => !(e.type === type && e.key === key));
  notesToReport.push({ id: uid(), type, key, artist: entity.artist, title, note, targets, createdAt: Date.now(), albumId: type === 'album' ? entity.id : undefined });
}

// Retire automatiquement les cibles Discogs/RYM détectées comme reportées (via réimport), et
// la cible MusicBee quand l'album n'a en réalité aucune tracklist MusicBee (cas des entrées
// créées avant le correctif v2026.07.10-27, ou d'un album jamais destiné à rejoindre MusicBee).
// Retourne true si quelque chose a changé (pour déclencher une sauvegarde).
function pruneNotesToReport() {
  let changed = false;
  notesToReport.forEach(entry => {
    if (entry.type !== 'album') return;
    // Rétro-remplissage : les entrées créées avant v2026.07.10-27 n'ont pas d'albumId stocké,
    // nécessaire aux deux vérifications ci-dessous (association RYM manuelle, présence réelle
    // MusicBee). Résolu une fois pour toutes ici via la clé normalisée déjà stockée.
    if (!entry.albumId) {
      const match = albums.find(x => normalizeKey(x.artist, x.album) === entry.key);
      if (match) { entry.albumId = match.id; changed = true; }
    }
    if (entry.targets.includes('discogs')) {
      const a = albums.find(x => normalizeKey(x.artist, x.album) === entry.key);
      if (a?.discogsRating) { entry.targets = entry.targets.filter(t => t !== 'discogs'); changed = true; }
    }
    if (entry.targets.includes('rym')) {
      // albumId transmis à lookupRym() pour retomber sur une association RYM manuelle si le nom
      // ne matche pas automatiquement (même correctif que Session notation, v2026.07.10-26).
      const rymEntry = lookupRym(entry.artist, entry.title, entry.albumId) || lookupRym(cleanDiscogsArtist(entry.artist), entry.title, entry.albumId);
      if (rymEntry?.rating) { entry.targets = entry.targets.filter(t => t !== 'rym'); changed = true; }
    }
    if (entry.targets.includes('musicbee') && entry.albumId) {
      const hasMusicBeeFile = (albumTracksCache[entry.albumId] || []).some(t => t.source === 'musicbee');
      if (!hasMusicBeeFile) { entry.targets = entry.targets.filter(t => t !== 'musicbee'); changed = true; }
    }
  });
  const before = notesToReport.length;
  notesToReport = notesToReport.filter(e => e.targets.length > 0);
  if (notesToReport.length !== before) changed = true;
  if (changed) saveToStorage();
  return changed;
}

// Marquer une cible précise comme reportée (clic manuel — utilisé pour MusicBee,
// et en filet de secours pour Discogs/RYM si la détection automatique n'a pas eu lieu)
function dismissReportTarget(id, target) {
  const entry = notesToReport.find(e => e.id === id);
  if (!entry) return;
  entry.targets = entry.targets.filter(t => t !== target);
  if (!entry.targets.length) notesToReport = notesToReport.filter(e => e.id !== id);
  saveToStorage();
  renderNotesToReport();
}

function removeNoteToReport(id) {
  notesToReport = notesToReport.filter(e => e.id !== id);
  saveToStorage();
  renderNotesToReport();
}

let ntrFilter = 'all'; // 'all' | 'album' | 'track'

function setNtrFilter(type) {
  ntrFilter = type;
  const btnAll = document.getElementById('ntr-filter-btn-all');
  const btnAlbum = document.getElementById('ntr-filter-btn-album');
  const btnTrack = document.getElementById('ntr-filter-btn-track');
  if (btnAll) btnAll.classList.toggle('active', type === 'all');
  if (btnAlbum) btnAlbum.classList.toggle('active', type === 'album');
  if (btnTrack) btnTrack.classList.toggle('active', type === 'track');
  renderNotesToReport();
}

// Groupé par type (Albums d'abord, puis Morceaux) avec une ligne d'en-tête de groupe, plutôt
// qu'un simple mélange trié par date : les deux servent des cibles très différentes (RYM pour les
// albums, MusicBee seul pour les morceaux) et ne doivent pas être confondus au premier coup d'œil.
function renderNotesToReport() {
  pruneNotesToReport();
  const albumCount = notesToReport.filter(e => e.type === 'album').length;
  const trackCount = notesToReport.filter(e => e.type === 'track').length;
  const counter = document.getElementById('ntr-counter');
  if (counter) counter.textContent = `${albumCount} album(s) · ${trackCount} morceau(x) à reporter`;
  const tbody = document.getElementById('ntr-tbody');
  if (!tbody) return;
  if (!notesToReport.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📋</div>Rien à reporter — tout est synchronisé.</div></td></tr>';
    return;
  }

  const rowHtml = e => {
    const pills = e.targets.map(t =>
      `<span class="badge badge-stock" style="cursor:pointer" onclick="dismissReportTarget('${e.id}','${t}')" title="Marquer ${NTR_TARGET_LABELS[t]} comme reporté">${NTR_TARGET_LABELS[t]} ✕</span>`
    ).join(' ');
    return `<tr>
      <td>${e.type === 'album' ? '💿 Album' : '🎵 Morceau'}</td>
      <td>${esc(e.artist)}</td>
      <td>${esc(e.title)}</td>
      <td class="mono" style="color:var(--accent)">${e.note}★</td>
      <td><div class="badges-cell">${pills}</div></td>
      <td><button class="btn btn-sm btn-danger" onclick="removeNoteToReport('${e.id}')" title="Retirer de la liste">✕</button></td>
    </tr>`;
  };
  const groupHeaderHtml = (label, count) =>
    `<tr><td colspan="6" style="background:var(--bg2);font-size:11px;font-weight:600;color:var(--text3);letter-spacing:0.5px;text-transform:uppercase;padding:8px 12px">${label} (${count})</td></tr>`;

  const albumEntries = notesToReport.filter(e => e.type === 'album').sort((a, b) => b.createdAt - a.createdAt);
  const trackEntries = notesToReport.filter(e => e.type === 'track').sort((a, b) => b.createdAt - a.createdAt);

  let html = '';
  if (ntrFilter !== 'track' && albumEntries.length) {
    html += groupHeaderHtml('💿 Albums — vers RYM (+ Discogs/MusicBee)', albumEntries.length);
    html += albumEntries.map(rowHtml).join('');
  }
  if (ntrFilter !== 'album' && trackEntries.length) {
    html += groupHeaderHtml('🎵 Morceaux — vers MusicBee', trackEntries.length);
    html += trackEntries.map(rowHtml).join('');
  }
  if (!html) {
    html = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📋</div>Rien à reporter dans cette catégorie.</div></td></tr>';
  }
  tbody.innerHTML = html;
}

function exportNotesToReportCSV() {
  const rows = [['Type', 'Artiste', 'Titre', 'Note', 'Cibles restantes']];
  notesToReport.forEach(e => rows.push([
    e.type === 'album' ? 'Album' : 'Morceau', e.artist, e.title, e.note,
    e.targets.map(t => NTR_TARGET_LABELS[t]).join(' + ')
  ]));
  _csvDownload(`notes_a_reporter_${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

// ===================== NOTATION DES MORCEAUX DE TRACKLIST (demi-étoiles) =====================
// Le champ `rating` sur les pistes source=musicbee vient de l'import XML (tag Rating MusicBee,
// arrondi à l'étoile entière) et est ENTIÈREMENT écrasé à chaque réimport (cf.
// importMusicBeeTracklists). trackNoteOverrides est donc stocké à part, jamais dans
// albumTracksCache, pour survivre aux réimports — et permet en prime la demi-étoile,
// que MusicBee arrondit en interne.
function trackNoteKey(albumId, title) {
  return albumId + '§' + normalizeKey('', title).replace('|||', '');
}

// Widget demi-étoiles (piste d'album) — data-* + délégation d'événement plutôt que des onclick
// inline avec ids/titres encodés en base64 (sid()/unsid()), pour éliminer tout risque d'échappement
// et permettre un seul point d'écoute fiable quel que soit le conteneur (modale ou session).
function halfStarsHtml(value, albumId, title) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const fillPct = value >= i ? 100 : (value >= i - 0.5 ? 50 : 0);
    html += `<span class="hstar-wrap">
      <span class="hstar-bg">★</span>
      <span class="hstar-fill" style="width:${fillPct}%">★</span>
      <button class="hstar-hit left" data-album-id="${escAttr(albumId)}" data-title="${escAttr(title)}" data-value="${i - 0.5}" title="${i - 0.5}★"></button>
      <button class="hstar-hit right" data-album-id="${escAttr(albumId)}" data-title="${escAttr(title)}" data-value="${i}" title="${i}★"></button>
    </span>`;
  }
  return html;
}

// Widget demi-étoiles grand format pour la notation ALBUM de la Session notation (même mécanique
// que halfStarsHtml, juste plus grand et sans album-id/title car la cible est déterminée par
// rsRateCurrent() via la file en cours, pas par les data-*).
function bigHalfStarsHtml(value) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const fillPct = value >= i ? 100 : (value >= i - 0.5 ? 50 : 0);
    html += `<span class="hstar-wrap hstar-wrap-lg">
      <span class="hstar-bg">★</span>
      <span class="hstar-fill" style="width:${fillPct}%">★</span>
      <button class="hstar-hit rs-star-hit left" data-value="${i - 0.5}" title="${i - 0.5}★"></button>
      <button class="hstar-hit rs-star-hit right" data-value="${i}" title="${i}★"></button>
    </span>`;
  }
  return html;
}

// Écoute déléguée unique pour tous les widgets demi-étoiles de l'app (modale tracklist, panneau
// Session notation, gros widget album de la Session notation) — évite de ré-attacher des handlers
// à chaque re-rendu et élimine les soucis d'échappement des onclick inline précédents.
document.addEventListener('click', function(e) {
  const rsBtn = e.target.closest('.rs-star-hit');
  if (rsBtn) { rsRateCurrent(parseFloat(rsBtn.dataset.value)); return; }
  const trackNoteBtn = e.target.closest('.rs-track-note-btn');
  if (trackNoteBtn) { submitAlbumTrackNoteInput(trackNoteBtn.closest('.rs-track-note-inline')); return; }
  const trackLabel = e.target.closest('.rs-track-row-click');
  if (trackLabel) { promptRateAlbumTrack(trackLabel.dataset.albumId, trackLabel.dataset.title); return; }
  const btn = e.target.closest('.hstar-hit');
  if (btn) { rateAlbumTrack(btn.dataset.albumId, btn.dataset.title, parseFloat(btn.dataset.value)); }
});
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const inp = e.target.closest('.rs-track-note-input');
  if (inp) { e.preventDefault(); submitAlbumTrackNoteInput(inp.closest('.rs-track-note-inline')); }
});

// Lit et valide la valeur du champ numérique d'une ligne de piste, puis applique la note — chemin
// partagé par le clic sur ✓ et la touche Entrée dans le champ.
function submitAlbumTrackNoteInput(wrap) {
  if (!wrap) return;
  const inp = wrap.querySelector('.rs-track-note-input');
  if (!inp) return;
  const albumId = wrap.dataset.albumId, title = wrap.dataset.title;
  const raw = inp.value.trim().replace(',', '.');
  let note = 0;
  if (raw !== '') {
    const n = parseFloat(raw);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)', 'warn'); return; }
    note = Math.round(n * 2) / 2;
  }
  _applyAlbumTrackRating(albumId, title, note);
}

function renderAlbumTracklistPanel(albumId, containerId) {
  containerId = containerId || 'modal-tracklist-list';
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const mbTracks = (albumTracksCache[albumId] || [])
    .filter(t => t.source === 'musicbee')
    .slice()
    .sort((a, b) => (parseInt(a.position, 10) || 999) - (parseInt(b.position, 10) || 999));
  if (!mbTracks.length) {
    wrap.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:6px 2px">Aucune tracklist MusicBee associée à cet album (importez/associez le XML MusicBee).</div>';
    return;
  }
  // Champ numérique TOUJOURS VISIBLE par piste (en plus des étoiles) — contrairement au clic sur
  // le titre (promptRateAlbumTrack, conservé mais peu visible), un vrai <input> est une cible large
  // et sans ambiguïté, moins vulnérable à une extension navigateur qui incruste une icône flottante
  // au survol des petites cibles étoile (cf. v2026.07.08-11/-14). z-index dédié (voir CSS
  // .rs-track-note-inline) pour rester au-dessus de ce type d'incrustation.
  wrap.innerHTML = mbTracks.map(t => {
    const key = trackNoteKey(albumId, t.title);
    const value = Object.prototype.hasOwnProperty.call(trackNoteOverrides, key) ? trackNoteOverrides[key] : (t.rating || 0);
    const listenBtn = `<button class="btn btn-sm" onclick="listenToAlbumTrack('${sid(albumId)}','${sid(t.title)}','${sid(t.mb_recording_id||'')}')" title="${t.mb_recording_id ? 'Écouter sur YouTube Music (lien direct MusicBrainz si disponible)' : 'Chercher sur YouTube Music'}">▶️</button>`;
    return `<div class="rs-track-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px;border-bottom:1px solid var(--border)">
      <div class="rs-track-row-click" data-album-id="${escAttr(albumId)}" data-title="${escAttr(t.title)}" title="Cliquer pour saisir une note au clavier" style="cursor:pointer;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${t.position ? esc(t.position) + '. ' : ''}${esc(t.title)}</div>
      <div class="hstars">${halfStarsHtml(value, albumId, t.title)}</div>
      <div class="rs-track-note-inline" data-album-id="${escAttr(albumId)}" data-title="${escAttr(t.title)}">
        <input type="text" inputmode="decimal" class="rs-track-note-input" placeholder="0-5" value="${value || ''}" title="Note (0 à 5, demi-étoiles possibles)">
        <button class="btn btn-sm rs-track-note-btn" title="Valider la note">✓</button>
      </div>
      ${listenBtn}
    </div>`;
  }).join('');
}

// Mutation effective (note d'une piste d'album) + effets de bord (report, sauvegarde, re-rendu) —
// factorisée pour être appelée à la fois par le clic étoile (toggle) et par la saisie clavier
// (valeur absolue, pas de toggle) sans dupliquer la logique.
function _applyAlbumTrackRating(albumId, title, newVal) {
  const key = trackNoteKey(albumId, title);
  trackNoteOverrides[key] = newVal;
  invalidateCache(); // buildAlbumTracksList doit refléter le nouveau rating
  // Comparaison souple : albumId ici est toujours une string (attribut data-*), alors que
  // albums[].id est un nombre (uid()) — l'ancienne version en === stricte ne matchait donc jamais,
  // ce qui empêchait silencieusement l'alimentation de "Notes à reporter" pour les pistes d'album.
  const album = albums.find(x => String(x.id) === String(albumId));
  if (newVal && album) queueNoteToReport('track', { artist: album.artist, title }, newVal);
  saveToStorage();
  // Rafraîchit les 2 emplacements possibles où cette tracklist peut être affichée (modale édition
  // album, et panneau embarqué dans la Session notation) — chacun est un no-op si absent du DOM.
  renderAlbumTracklistPanel(albumId, 'modal-tracklist-list');
  renderAlbumTracklistPanel(albumId, 'rs-album-tracklist-list');
}

function rateAlbumTrack(albumId, title, value) {
  const key = trackNoteKey(albumId, title);
  const mbT = (albumTracksCache[albumId] || []).find(t => t.source === 'musicbee' && t.title === title);
  const current = Object.prototype.hasOwnProperty.call(trackNoteOverrides, key) ? trackNoteOverrides[key] : (mbT?.rating || 0);
  const newVal = current === value ? 0 : value; // reclic sur la même valeur → efface la note
  _applyAlbumTrackRating(albumId, title, newVal);
}

// Saisie clavier de la note d'une piste (clic sur le titre plutôt que sur les étoiles) — contourne
// les extensions navigateur qui interceptent parfois le clic sur les mini cibles étoile, et permet
// de taper directement la valeur comme pour les scrobbles last.fm (rateScrobbleTrack).
function promptRateAlbumTrack(albumId, title) {
  const key = trackNoteKey(albumId, title);
  const mbT = (albumTracksCache[albumId] || []).find(t => t.source === 'musicbee' && t.title === title);
  const current = Object.prototype.hasOwnProperty.call(trackNoteOverrides, key) ? trackNoteOverrides[key] : (mbT?.rating || 0);
  const raw = prompt(`Note pour "${title}" (0 à 5, demi-étoiles possibles) :`, current || '');
  if (raw === null) return;
  const trimmed = raw.trim().replace(',', '.');
  let note = 0;
  if (trimmed !== '') {
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0 || n > 5) { toast('Valeur invalide (0 à 5)', 'warn'); return; }
    note = Math.round(n * 2) / 2;
  }
  _applyAlbumTrackRating(albumId, title, note);
}

// ===================== SCORE DE CONFIANCE VISIBLE (matching MB / RYM) =====================
// Le matching MusicBrainz par recherche floue (searchMusicBrainz, auto-accepté si score>=90)
// et le matching RYM par variante d'artiste prenaient des décisions silencieuses, sans aucune
// trace consultable — impossible de revalider un cas limite sans deviner. Ce panneau, affiché
// dans le détail album, rend ces décisions visibles et actionnables.
function renderMatchConfidencePanel(albumId) {
  const wrap = document.getElementById('modal-match-confidence');
  if (!wrap) return;
  const a = albums.find(x => x.id === albumId);
  if (!a) { wrap.innerHTML = ''; return; }
  const rows = [];

  // ── MusicBrainz ──
  if (a.mb_release_id) {
    const mbUrl = `https://musicbrainz.org/release/${a.mb_release_id}`;
    if (a.mb_match_score != null) {
      const scoreColor = a.mb_match_score >= 98 ? 'var(--accent)' : a.mb_match_score >= 90 ? 'var(--amber)' : 'var(--red)';
      rows.push(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>🔎 MusicBrainz : matché automatiquement par recherche — <span style="color:${scoreColor};font-family:var(--mono)">${a.mb_match_score}% confiance</span></span>
        <a href="${mbUrl}" target="_blank" style="color:var(--text3)">Vérifier ↗</a>
        <button class="btn btn-sm" onclick="resetMbMatch('${sid(albumId)}')" title="Effacer ce matching (à corriger manuellement ou relancer une recherche)">✕ Réinitialiser</button>
      </div>`);
    } else {
      rows.push(`<div>🔎 MusicBrainz : lié via le tag MBID du fichier ou l'ID Discogs (fiable) — <a href="${mbUrl}" target="_blank" style="color:var(--text3)">voir ↗</a></div>`);
    }
  } else {
    rows.push('<div style="opacity:0.55">🔎 MusicBrainz : pas encore lié</div>');
  }

  // ── RYM ──
  const rymRes = lookupRymWithMeta(a.artist, a.album, a.id);
  if (rymRes.entry) {
    const labelByType = { exact: 'correspondance exacte', fuzzy: "variante d'artiste — à vérifier", manual: 'association manuelle' };
    const colorByType = { exact: 'var(--accent)', fuzzy: 'var(--amber)', manual: 'var(--accent)' };
    rows.push(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span>⭐ RYM : ${rymRes.entry.rating.toFixed(2)}★ — <span style="color:${colorByType[rymRes.matchType]}">${labelByType[rymRes.matchType]}</span></span>
      ${rymRes.matchType === 'fuzzy' ? `<button class="btn btn-sm" onclick="openRYMAssocFromCollection('${sid(albumId)}')" title="Vérifier/corriger l'association RYM">Vérifier</button>` : ''}
    </div>`);
  } else {
    rows.push('<div style="opacity:0.55">⭐ RYM : pas de note trouvée</div>');
  }

  wrap.innerHTML = rows.join('');
}

function resetMbMatch(albumIdSid) {
  const albumId = unsid(albumIdSid);
  const a = albums.find(x => x.id === albumId);
  if (!a) return;
  if (!confirm('Effacer le lien MusicBrainz de cet album ? La tracklist MusicBrainz associée sera aussi retirée (les autres sources restent intactes).')) return;
  a.mb_release_id = undefined;
  a.mb_match_score = undefined;
  albumTracksCache[albumId] = (albumTracksCache[albumId] || []).filter(t => t.source !== 'musicbrainz');
  invalidateCache();
  saveToStorage();
  renderMatchConfidencePanel(albumId);
  toast('Lien MusicBrainz effacé — un nouveau matching pourra être relancé');
}

// ===================== PANNEAU PROVENANCE DES CHAMPS =====================
// Todo section 2 — remplace le besoin de boutons ad hoc par champ/source (comme
// refreshMbYearGenres) par un panneau générique dans la fiche album.
const PROVENANCE_FIELD_LABELS = { year: 'Année', genre: 'Genre', artist: 'Artiste', cover_url: 'Pochette', label: 'Label' };

function renderProvenancePanel(albumId) {
  const wrap = document.getElementById('modal-field-provenance');
  if (!wrap) return;
  const a = albums.find(x => x.id === albumId || x.id === String(albumId));
  if (!a) { wrap.innerHTML = ''; return; }
  const rows = PROVENANCE_FIELDS.map(f => {
    if (!a[f]) return `<div style="opacity:0.5">${PROVENANCE_FIELD_LABELS[f]} : vide</div>`;
    const p = a.field_provenance?.[f];
    if (!p) return `<div style="opacity:0.7">${PROVENANCE_FIELD_LABELS[f]} : source inconnue (valeur antérieure à ce suivi) — <button class="btn btn-sm" onclick="toggleFieldLock('${sid(a.id)}','${f}')" title="Verrouiller manuellement">🔓</button></div>`;
    const isManual = p.source === 'manual';
    const srcLabel = PROVENANCE_SOURCE_LABELS[p.source] || p.source;
    const age = formatProvenanceAge(p.synced_at);
    return `<div style="display:flex;align-items:center;gap:6px">
      <span>${PROVENANCE_FIELD_LABELS[f]} : ${srcLabel}${age ? ` — ${age}` : ''}</span>
      <button class="btn btn-sm" onclick="toggleFieldLock('${sid(a.id)}','${f}')" title="${isManual ? 'Déverrouiller (redevient rafraîchissable automatiquement)' : 'Verrouiller manuellement (ne sera plus jamais écrasé par un import/enrichissement auto)'}">${isManual ? '🔒' : '🔓'}</button>
    </div>`;
  }).join('');

  // Suggestion de genre RYM (todo section 6) : RYM propose souvent un genre plus fin/plus
  // "ambiance" que Discogs/MusicBrainz (ex. "Dream Pop" vs "Rock"). Jamais appliqué
  // automatiquement — juste signalé, comme la suggestion de note RYM en Session notation.
  const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
  const rymGenre = (rymEntry?.genre || '').split(',')[0].trim();
  const rymGenreRow = (rymGenre && rymGenre.toLowerCase() !== (a.genre || '').toLowerCase())
    ? `<div style="color:var(--amber)">Genre RYM : ${esc(rymGenre)} <span style="color:var(--text3)">(suggestion, jamais appliquée automatiquement)</span> <button class="btn btn-sm" onclick="applySourceFieldValue('${sid(a.id)}','genre','rym','${esc(rymGenre).replace(/'/g,"\\'")}')" title="Appliquer ce genre">↳</button></div>`
    : '';

  wrap.innerHTML = rows + rymGenreRow;
}

function toggleFieldLock(albumIdSid, field) {
  const albumId = unsid(albumIdSid);
  const a = albums.find(x => x.id === albumId || x.id === String(albumId));
  if (!a) return;
  if (isManualField(a, field)) {
    if (a.field_provenance) delete a.field_provenance[field]; // déverrouille — source oubliée, redevient rafraîchissable
  } else {
    setProvenance(a, field, 'manual');
  }
  saveToStorage();
  renderProvenancePanel(a.id);
}

// ===================== COMPARAISON MULTI-SOURCE (généralisation du pattern cmp.discogs/cmp.musicbrainz =====================
// déjà en place pour les tracklists) à year/genre/label/country. Cache session uniquement
// (comme albumTracksCache) — repeuplé à chaque "🔄 Rafraîchir depuis la source" quand l'album
// a les deux IDs (Discogs + MusicBrainz), jamais persisté : c'est une aide au diagnostic ponctuel,
// pas une donnée de collection. N'automatise aucune résolution — affiche les divergences et laisse
// le choix (bouton "Appliquer" par champ/source), dans le même esprit que showTracklistDiff().
const SOURCE_CMP_FIELDS = ['year', 'genre', 'label', 'country'];
const SOURCE_CMP_FIELD_LABELS = { year: 'Année', genre: 'Genre', label: 'Label', country: 'Pays' };
let _sourceCmpCache = {};

function extractYear4(dateStr) {
  const m = String(dateStr || '').match(/\d{4}/);
  return m ? m[0] : '';
}

function renderSourceComparisonPanel(albumId) {
  const wrap = document.getElementById('modal-source-cmp');
  const wrapOuter = document.getElementById('modal-source-cmp-wrap');
  if (!wrap || !wrapOuter) return;
  const a = albums.find(x => x.id === albumId || x.id === String(albumId));
  const cmp = _sourceCmpCache[albumId];
  if (!a || !cmp || !cmp.discogs || !cmp.musicbrainz) { wrapOuter.style.display = 'none'; wrap.innerHTML = ''; return; }

  const rows = SOURCE_CMP_FIELDS.map(f => {
    const dv = cmp.discogs[f] || '';
    const mv = cmp.musicbrainz[f] || '';
    if (!dv && !mv) return '';
    const differ = dv && mv && dv !== mv;
    const current = a[f] || '';
    const cell = (label, val, source) => !val ? `<span style="opacity:0.4">–</span>` : `<span style="${differ ? 'color:var(--amber)' : ''}">${esc(val)}</span>${(f !== 'country' && val && val !== current) ? ` <button class="btn btn-sm" onclick="applySourceFieldValue('${sid(a.id)}','${f}','${source}','${esc(val).replace(/'/g,"\\'")}')" title="Appliquer cette valeur">↳</button>` : ''}`;
    return `<div style="display:flex;gap:10px;align-items:center;${differ ? 'color:var(--amber)' : ''}">
      <span style="min-width:56px;font-weight:500">${SOURCE_CMP_FIELD_LABELS[f]}${differ ? ' ⚠️' : ''}</span>
      <span style="min-width:170px">💿 ${cell('Discogs', dv, 'discogs')}</span>
      <span>🔵 ${cell('MusicBrainz', mv, 'musicbrainz')}</span>
    </div>`;
  }).filter(Boolean).join('');

  if (!rows) { wrapOuter.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrapOuter.style.display = '';
  wrap.innerHTML = rows + `<div style="margin-top:4px;opacity:0.6;font-size:11px">⚠️ = divergence entre sources — ↳ pour appliquer une valeur au champ de l'album (Pays : informatif uniquement, pas de champ dédié sur la fiche album)</div>`;
}

// Crédits MusicBrainz (todo section 6, item ⬜) : relations artiste posées au niveau release
// (producteur, ingénieur, mixage, arrangement...). Affiché seulement si présent — simple
// panneau informatif comme le badge type, alimenté au fetch (fetchAllTracklists,
// refreshAlbumFromSource), jamais édité manuellement.
const MB_CREDIT_ROLE_LABELS = {
  producer: 'Production', 'executive producer': 'Production exécutive', engineer: 'Ingénieur du son',
  mix: 'Mixage', mastering: 'Mastering', recording: 'Enregistrement', arranger: 'Arrangement',
  orchestrator: 'Orchestration', conductor: 'Direction', composer: 'Composition', lyricist: 'Paroles',
  writer: 'Écriture', remixer: 'Remix', programming: 'Programmation', vocal: 'Voix',
  instrument: 'Instrument', performer: 'Interprétation', 'liner notes': 'Livret',
  'art direction': 'Direction artistique', photography: 'Photographie', design: 'Design',
  illustration: 'Illustration', compiler: 'Compilation',
};
function renderMbCreditsPanel(albumId) {
  const wrap = document.getElementById('modal-mb-credits');
  const wrapOuter = document.getElementById('modal-mb-credits-wrap');
  if (!wrap || !wrapOuter) return;
  const a = albums.find(x => x.id === albumId || x.id === String(albumId));
  const credits = a?.mb_credits || [];
  if (!credits.length) { wrapOuter.style.display = 'none'; wrap.innerHTML = ''; return; }

  const byRole = {};
  credits.forEach(c => {
    if (!c.role || !c.name) return;
    (byRole[c.role] = byRole[c.role] || new Set()).add(c.name);
  });
  const rows = Object.keys(byRole).sort().map(role => {
    const label = MB_CREDIT_ROLE_LABELS[role] || (role.charAt(0).toUpperCase() + role.slice(1));
    return `<div><span style="font-weight:500">${esc(label)}</span> : ${esc([...byRole[role]].join(', '))}</div>`;
  }).join('');

  if (!rows) { wrapOuter.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrapOuter.style.display = '';
  wrap.innerHTML = rows + `<div style="margin-top:4px;opacity:0.6;font-size:11px">Relations posées au niveau release sur MusicBrainz — le compositeur par morceau (lien recording→work) n'est pas récupéré (trop coûteux en appels API à 1 req/s).</div>`;
}

// ===================== DISCOGRAPHIE MANQUANTE PAR ARTISTE =====================
// Todo section 11, item ⬜ « Discographie manquante par artiste : pour un artiste possédé,
// lister via MB les albums du groupe absents de la collection, avec ajout direct à la wishlist.
// 1 lookup MB par artiste, à la demande. » Contrairement aux autres enrichissements MB de l'app
// (mb_credits, cover, année d'origine...), qui passent tous par l'Edge Function get-release-info
// (accès non disponible ici pour lui ajouter un nouveau mode), ceci appelle l'API publique
// MusicBrainz DIRECTEMENT depuis le navigateur (ws/2/artist puis ws/2/release-group, toutes
// deux CORS-ouvertes en GET) — 2 requêtes séquentielles par clic sur "🔍 Chercher", jamais en
// masse/auto, conforme à la limite de 1 req/s de MusicBrainz pour un usage non-authentifié.
let _missingDiscogList = []; // dernier résultat, indexé pour les boutons "+ Wishlist" (évite d'échapper artiste/titre dans des onclick)

async function searchMissingDiscography() {
  const artist = document.getElementById('f-artist').value.trim();
  if (!artist) return;
  const btn = document.getElementById('btn-missing-discog');
  const out = document.getElementById('modal-missing-discog');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Recherche…'; }
  if (out) out.innerHTML = '';
  _missingDiscogList = [];
  try {
    // 1) MBID de l'artiste — recherche par nom, meilleur score MusicBrainz (1er résultat trié par score)
    const sRes = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent('artist:"' + artist + '"')}&fmt=json&limit=5`);
    if (!sRes.ok) throw new Error('MusicBrainz indisponible (HTTP ' + sRes.status + ')');
    const sData = await sRes.json();
    const best = (sData.artists || [])[0];
    if (!best) { if (out) out.innerHTML = '<div>Artiste introuvable sur MusicBrainz.</div>'; return; }

    // 2) Release-groups (albums + EP studio) de cet artiste
    const rRes = await fetch(`https://musicbrainz.org/ws/2/release-group?artist=${best.id}&type=album|ep&limit=100&fmt=json`);
    if (!rRes.ok) throw new Error('MusicBrainz indisponible (HTTP ' + rRes.status + ')');
    const rData = await rRes.json();
    const groups = rData['release-groups'] || [];

    // 3) Comparaison aux albums déjà possédés de cet artiste, toutes variantes de nom confondues
    //    (artistVariants(), même mécanisme que le reste de l'app) — exclut live/compilation/
    //    soundtrack/remix côté MusicBrainz (secondary-types), pour ne pointer que des sorties
    //    studio manquantes plutôt que des rééditions ou compiles qui gonfleraient la liste.
    const artVariants = artistVariants(artist);
    const ownedTitles = new Set();
    albums.forEach(a => {
      if ([...artistVariants(a.artist)].some(v => artVariants.has(v))) {
        ownedTitles.add(normalizeKey('', a.album).replace('|||', ''));
      }
    });
    const EXCLUDED_SECONDARY = ['Live', 'Compilation', 'Soundtrack', 'Interview', 'Spokenword', 'Remix', 'DJ-mix', 'Mixtape/Street'];
    const missing = groups.filter(g => {
      const secondary = g['secondary-types'] || [];
      if (secondary.some(t => EXCLUDED_SECONDARY.includes(t))) return false;
      const key = normalizeKey('', g.title || '').replace('|||', '');
      return key && !ownedTitles.has(key);
    }).sort((a, b) => (a['first-release-date'] || '9999').localeCompare(b['first-release-date'] || '9999'));

    _missingDiscogList = missing;
    if (!out) return;
    if (!missing.length) {
      out.innerHTML = `Rien de manquant — discographie complète sur MusicBrainz pour <b>${esc(best.name)}</b> (${groups.length} album(s)/EP analysés).`;
      return;
    }
    out.innerHTML = `<div style="margin-bottom:6px">${missing.length} absent(s) de ta collection sur ${groups.length} chez <b>${esc(best.name)}</b> :
        <button class="btn btn-sm" type="button" onclick="addAllMissingDiscogToWishlist()">+ Tout ajouter à la wishlist</button></div>` +
      missing.map((g, i) => {
        const year = (g['first-release-date'] || '').slice(0, 4);
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span>${esc(g.title)}${year ? ` <span style="opacity:0.6">(${esc(year)})</span>` : ''}${g['primary-type']==='EP' ? ' <span style="opacity:0.6">[EP]</span>' : ''}</span>
          <button class="btn btn-sm" type="button" onclick="addMissingDiscogToWishlist(${i})">+ Wishlist</button>
        </div>`;
      }).join('');
  } catch (e) {
    console.error('searchMissingDiscography:', e);
    if (out) out.innerHTML = 'Erreur MusicBrainz : ' + esc(e.message || e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Chercher sur MusicBrainz'; }
  }
}

function addMissingDiscogToWishlist(i) {
  const g = _missingDiscogList[i];
  if (!g) return;
  const artist = document.getElementById('f-artist').value.trim();
  const year = (g['first-release-date'] || '').slice(0, 4);
  addToWishlist(artist, g.title, year, 'discography', 0, 0, '');
}

function addAllMissingDiscogToWishlist() {
  if (!_missingDiscogList.length) return;
  const artist = document.getElementById('f-artist').value.trim();
  let added = 0;
  _missingDiscogList.forEach(g => {
    const before = wishlist.length;
    addToWishlist(artist, g.title, (g['first-release-date'] || '').slice(0, 4), 'discography', 0, 0, '');
    if (wishlist.length > before) added++;
  });
  toast(`${added} album(s) ajouté(s) à la wishlist`);
}

function applySourceFieldValue(albumIdSid, field, source, value) {
  const albumId = unsid(albumIdSid);
  const a = albums.find(x => x.id === albumId || x.id === String(albumId));
  if (!a || !value) return;
  a[field] = value;
  setProvenance(a, field, source);
  saveToStorage();
  if (field === 'genre' && document.getElementById('f-genre')) document.getElementById('f-genre').value = value;
  renderProvenancePanel(a.id);
  renderSourceComparisonPanel(a.id);
  invalidateCache();
  renderAlbums(); renderDiscographie();
  toast(`${SOURCE_CMP_FIELD_LABELS[field]} appliqué depuis ${source === 'discogs' ? 'Discogs' : 'MusicBrainz'} ✓`);
}

// Bouton générique "🔄 Rafraîchir depuis la source" — recontacte Discogs/MusicBrainz
// pour l'album en cours d'édition et met à jour genre/pochette/label, en ignorant
// tout champ verrouillé 🔒 manuellement. Remplace le besoin de boutons ad hoc par
// champ (l'ancien refreshMbYearGenres reste disponible séparément pour le backfill
// en masse année/genre/youtube depuis Import/Export).
async function refreshAlbumFromSource() {
  const eid = document.getElementById('edit-id').value;
  const a = albums.find(x => x.id == eid || x.id === String(eid));
  if (!a) { toast("Enregistrez d'abord l'album avant de rafraîchir", 'warn'); return; }
  if (!a.discogsId && !a.mb_release_id) { toast('Aucune source liée (ID Discogs ou MusicBrainz requis)', 'warn'); return; }

  const btn = document.getElementById('btn-refresh-provenance');
  if (btn) btn.disabled = true;
  const updated = new Set();
  const rawCmp = { discogs: null, musicbrainz: null };

  if (a.discogsId) {
    try {
      const rel = await fetchDiscogsRelease(a.discogsId);
      rawCmp.discogs = { year: extractYear4(rel.release_date), genre: rel.genres?.[0] || '', label: rel.label || '', country: rel.country || '' };
      if (rel.genres?.length && !isManualField(a, 'genre') && a.genre !== rel.genres[0]) {
        a.genre = rel.genres[0]; setProvenance(a, 'genre', 'discogs'); updated.add('genre');
      }
      if (rel.cover_url && !rel.cover_url.includes('coverartarchive') && !isManualField(a, 'cover_url') && a.cover_url !== rel.cover_url) {
        a.cover_url = rel.cover_url; setProvenance(a, 'cover_url', 'discogs'); updated.add('pochette');
      }
      if (rel.label && !isManualField(a, 'label') && a.label !== rel.label) {
        a.label = rel.label; setProvenance(a, 'label', 'discogs'); updated.add('label');
      }
      if (rel.master_year && a.discogs_master_year !== rel.master_year) {
        a.discogs_master_year = rel.master_year; updated.add('année d\'origine Discogs');
      }
    } catch(e) { console.warn('Rafraîchissement Discogs:', e.message); }
  }

  if (a.mb_release_id) {
    try {
      if (a.discogsId) await new Promise(r => setTimeout(r, 700)); // marge Edge Fn entre 2 appels
      const rel = await fetchMusicBrainzRelease(a.mb_release_id);
      rawCmp.musicbrainz = { year: extractYear4(rel.release_date), genre: rel.genres?.[0] || '', label: rel.label || '', country: rel.country || '' };
      applyMbEnrichment(a, rel); // met à jour mb_original_year + youtube_url (respecte déjà le verrou manuel du genre)
      if (rel.genres?.length && !isManualField(a, 'genre') && a.genre !== rel.genres[0]) {
        a.genre = rel.genres[0]; setProvenance(a, 'genre', 'musicbrainz'); updated.add('genre');
      }
      if (rel.cover_url && !rel.cover_url.includes('coverartarchive') && !isManualField(a, 'cover_url') && a.cover_url !== rel.cover_url) {
        a.cover_url = rel.cover_url; setProvenance(a, 'cover_url', 'musicbrainz'); updated.add('pochette');
      }
      if (rel.label && !isManualField(a, 'label') && a.label !== rel.label) {
        a.label = rel.label; setProvenance(a, 'label', 'musicbrainz'); updated.add('label');
      }
      a.mb_refreshed_at = new Date().toISOString();
    } catch(e) { console.warn('Rafraîchissement MusicBrainz:', e.message); }
  }

  if (btn) btn.disabled = false;
  saveToStorage();
  _sourceCmpCache[a.id] = rawCmp;

  // Refléter dans le formulaire ouvert
  document.getElementById('f-genre').value = a.genre || '';
  if (document.getElementById('f-cover-url')) document.getElementById('f-cover-url').value = a.cover_url || '';
  const coverImg  = document.getElementById('modal-cover-img');
  const coverWrap = document.getElementById('modal-cover-wrap');
  if (a.cover_url && coverImg) { coverImg.src = a.cover_url; coverWrap.style.display = 'block'; }
  renderProvenancePanel(a.id);
  renderSourceComparisonPanel(a.id);
  renderMbCreditsPanel(a.id);
  invalidateCache();
  renderAlbums(); renderDiscographie();
  toast(updated.size ? `Rafraîchi : ${[...updated].join(', ')}` : 'Rien à mettre à jour (champs verrouillés 🔒 ou déjà à jour)');
}

// ===================== AUDIT COLLECTION — VUES GLOBALES =====================
// Regroupe 4 items ⬜ de la todo, tous de la même famille (« ce qui existe déjà par fiche,
// mais sans vue d'ensemble pour corriger en série ») : plutôt que 4 écrans séparés, un seul
// nouvel onglet "🔎 Audit" avec 4 blocs indépendants. Les 2 premiers sont calculés côté
// client à partir de données déjà chargées (instantané) ; les 2 derniers nécessitent des
// appels réseau par élément et restent donc à la demande (bouton "Scanner"), jamais
// automatiques ni persistés (comme _sourceCmpCache existant) — ce sont des outils de
// diagnostic ponctuel, pas des données de collection.

// --- Bloc 1 : scores de confiance MusicBrainz bas (todo section 6, item ⬜) ---
// album.mb_match_score (v2026.07.07-12) est déjà calculé par album ; ici juste un tri
// global croissant pour remonter directement les matches douteux.
function renderAuditMbScores() {
  const el = document.getElementById('audit-mbscore-list');
  if (!el) return;
  const flagged = albums.filter(a => a.mb_match_score != null && a.mb_match_score < 95)
    .sort((a, b) => (a.mb_match_score || 0) - (b.mb_match_score || 0));
  const counter = document.getElementById('audit-mbscore-counter');
  if (counter) counter.textContent = flagged.length ? `${flagged.length} match(s) douteux (< 95%)` : '';
  if (!flagged.length) {
    el.innerHTML = '<div class="empty" style="padding:16px"><div class="empty-icon">✅</div>Aucun score de confiance MusicBrainz bas.</div>';
    return;
  }
  el.innerHTML = flagged.map(a => {
    const color = a.mb_match_score >= 90 ? 'var(--amber)' : 'var(--red)';
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="editAlbum('${sid(a.id)}')">
      <div><div style="font-weight:500">${esc(a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(a.artist)}</div></div>
      <span style="font-family:var(--mono);color:${color}">${a.mb_match_score}%</span>
    </div>`;
  }).join('');
}

// --- Bloc 2 : notes perso vs RYM très divergentes (todo section 1, item ⬜) ---
// Purement informatif — jamais de note modifiée automatiquement. Un écart peut venir d'une
// mauvaise association RYM (à vérifier) ou d'un vrai désaccord de goût (rien à corriger).
const RYM_DIVERGENCE_THRESHOLD = 1.5;
function renderAuditRymDivergence() {
  const el = document.getElementById('audit-rymdiv-list');
  if (!el) return;
  const rows = [];
  albums.forEach(a => {
    if (!a.note) return;
    const rymEntry = lookupRym(a.artist, a.album, a.id) || lookupRym(cleanDiscogsArtist(a.artist), a.album, a.id);
    if (!rymEntry || !rymEntry.rating) return;
    const diff = Math.abs(a.note - rymEntry.rating);
    if (diff >= RYM_DIVERGENCE_THRESHOLD) rows.push({ a, rym: rymEntry.rating, diff });
  });
  rows.sort((x, y) => y.diff - x.diff);
  const counter = document.getElementById('audit-rymdiv-counter');
  if (counter) counter.textContent = rows.length ? `${rows.length} écart(s) ≥ ${RYM_DIVERGENCE_THRESHOLD}★` : '';
  if (!rows.length) {
    el.innerHTML = `<div class="empty" style="padding:16px"><div class="empty-icon">✅</div>Aucun écart ≥ ${RYM_DIVERGENCE_THRESHOLD}★ entre note perso et RYM.</div>`;
    return;
  }
  el.innerHTML = rows.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="editAlbum('${sid(r.a.id)}')">
    <div><div style="font-weight:500">${esc(r.a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(r.a.artist)}</div></div>
    <div style="font-family:var(--mono);text-align:right;font-size:12px"><span style="color:var(--text2)">${r.a.note.toFixed(1)}★ perso</span> · <span style="color:var(--amber)">${r.rym.toFixed(2)}★ RYM</span></div>
  </div>`).join('');
}

// --- Bloc 3 : divergences Discogs/MusicBrainz — vue globale (todo section 1, item ⬜) ---
// Le panneau par-fiche "🔍 Comparaison Discogs/MusicBrainz" (v2026.07.10-05) existe déjà mais
// n'est peuplé qu'au clic sur "Rafraîchir depuis la source" d'UNE fiche ouverte. Ici : mêmes
// 2 fetch (fetchDiscogsRelease/fetchMusicBrainzRelease) rejoués pour tous les albums ayant les
// deux IDs liés, pacés (même cadence que fetchAllMarketplaceStats), résultat non persisté —
// alimente aussi _sourceCmpCache au passage, donc la fiche album profite du scan si ouverte
// juste après. Lecture seule ici (pas de bouton "Appliquer" direct depuis la liste globale,
// volontairement — ouvrir la fiche via le "🔄 Rafraîchir" reste le point d'application, pour
// ne pas dupliquer applySourceFieldValue dans un contexte liste).
function sourceDivergenceEligibleAlbums() {
  return albums.filter(a => a.discogsId && a.mb_release_id);
}

async function fetchRawSourceCmp(a) {
  const rawCmp = { discogs: null, musicbrainz: null };
  if (a.discogsId) {
    try {
      const rel = await fetchDiscogsRelease(a.discogsId);
      rawCmp.discogs = { year: extractYear4(rel.release_date), genre: rel.genres?.[0] || '', label: rel.label || '', country: rel.country || '' };
    } catch (e) { console.warn('fetchRawSourceCmp (discogs):', a.artist, '—', a.album, e.message || e); }
  }
  if (a.mb_release_id) {
    try {
      if (a.discogsId) await new Promise(r => setTimeout(r, 700));
      const rel = await fetchMusicBrainzRelease(a.mb_release_id);
      rawCmp.musicbrainz = { year: extractYear4(rel.release_date), genre: rel.genres?.[0] || '', label: rel.label || '', country: rel.country || '' };
    } catch (e) { console.warn('fetchRawSourceCmp (musicbrainz):', a.artist, '—', a.album, e.message || e); }
  }
  return rawCmp;
}

let _globalCmpResults = [];  // session seulement, comme _sourceCmpCache
let _globalCmpScanning = false;
let _globalCmpStop = false;

async function scanAllSourceDivergences() {
  if (_globalCmpScanning) return;
  const targets = sourceDivergenceEligibleAlbums();
  const btn = document.getElementById('audit-cmp-scan-btn');
  const status = document.getElementById('audit-cmp-status');
  if (!targets.length) { if (status) status.textContent = 'Aucun album avec Discogs + MusicBrainz liés.'; return; }
  _globalCmpScanning = true;
  _globalCmpStop = false;
  _globalCmpResults = [];
  if (btn) { btn.textContent = '⏹ Arrêter le scan'; btn.onclick = () => { _globalCmpStop = true; }; }
  let done = 0;
  for (const a of targets) {
    if (_globalCmpStop) break;
    if (status) status.textContent = `${done}/${targets.length} — ${a.artist} — ${a.album}`;
    try {
      const cmp = await fetchRawSourceCmp(a);
      _sourceCmpCache[a.id] = cmp;
      const diffs = SOURCE_CMP_FIELDS.filter(f => cmp.discogs?.[f] && cmp.musicbrainz?.[f] && cmp.discogs[f] !== cmp.musicbrainz[f]);
      if (diffs.length) _globalCmpResults.push({ album: a, cmp, diffs });
    } catch (e) { console.warn('scanAllSourceDivergences:', a.artist, '—', a.album, e.message || e); }
    done++;
    await new Promise(r => setTimeout(r, 800)); // marge entre albums, en plus du délai interne discogs→mb
    if (done % 5 === 0) renderAuditSourceDivergences();
  }
  _globalCmpScanning = false;
  if (btn) { btn.textContent = `🔍 Scanner les divergences (${targets.length} albums)`; btn.onclick = scanAllSourceDivergences; }
  if (status) status.textContent = `${_globalCmpStop ? 'Arrêté' : 'Terminé'} — ${done}/${targets.length} scanné(s), ${_globalCmpResults.length} divergence(s) trouvée(s).`;
  renderAuditSourceDivergences();
}

function renderAuditSourceDivergences() {
  const el = document.getElementById('audit-cmp-list');
  if (!el) return;
  if (!_globalCmpResults.length) {
    el.innerHTML = `<div class="empty" style="padding:16px"><div class="empty-icon">🔍</div>${_globalCmpScanning ? 'Scan en cours…' : "Aucun résultat pour l'instant — lance le scan."}</div>`;
    return;
  }
  el.innerHTML = _globalCmpResults.map(r => {
    const fields = r.diffs.map(f => `<span style="color:var(--amber)">${SOURCE_CMP_FIELD_LABELS[f]}</span> : 💿 ${esc(r.cmp.discogs[f])} / 🔵 ${esc(r.cmp.musicbrainz[f])}`).join(' · ');
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="editAlbum('${sid(r.album.id)}')">
      <div><div style="font-weight:500">${esc(r.album.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(r.album.artist)}</div></div>
      <div style="font-size:12px;text-align:right;max-width:340px">${fields}</div>
    </div>`;
  }).join('');
}

// --- Bloc 4 : complétion de discographie — vue globale (todo section 11, item ⬜) ---
// La "Discographie manquante" existante (v2026.07.10-23) fonctionne artiste par artiste depuis
// la fiche album. Ici : même requête MusicBrainz publique (artist puis release-group, 2 req.
// séquentielles par artiste, ~1.1s d'écart chacune pour respecter la limite non-authentifiée
// ~1 req/s), rejouée pour tous les artistes possédés (discogsId requis, même définition
// d'ownership que la wishlist), triés par % de complétion croissant. Volontairement lent et
// à la demande avec bouton Arrêter — pas de raccourci possible sans clé API MusicBrainz
// authentifiée (hors scope). Clic sur une ligne : ouvre la fiche d'un album de cet artiste
// et relance directement la recherche "Discographie manquante" existante dans la modale.
function ownedArtistsList() {
  const map = new Map();
  albums.forEach(a => {
    if (!a.discogsId || !a.artist) return;
    const key = normArtistCore(a.artist);
    if (!map.has(key)) map.set(key, { artist: a.artist, count: 0, albumId: a.id });
    map.get(key).count++;
  });
  return [...map.values()].sort((a, b) => a.artist.localeCompare(b.artist, 'fr'));
}

let _globalDiscogResults = [];
let _globalDiscogScanning = false;
let _globalDiscogStop = false;
const DISCOG_SCAN_EXCLUDED_SECONDARY = ['Live', 'Compilation', 'Soundtrack', 'Interview', 'Spokenword', 'Remix', 'DJ-mix', 'Mixtape/Street'];

async function scanAllMissingDiscography() {
  if (_globalDiscogScanning) return;
  const targets = ownedArtistsList();
  const btn = document.getElementById('audit-discog-scan-btn');
  const status = document.getElementById('audit-discog-status');
  if (!targets.length) { if (status) status.textContent = 'Aucun artiste possédé (CD catalogué Discogs).'; return; }
  _globalDiscogScanning = true;
  _globalDiscogStop = false;
  _globalDiscogResults = [];
  if (btn) { btn.textContent = '⏹ Arrêter le scan'; btn.onclick = () => { _globalDiscogStop = true; }; }
  let done = 0;
  for (const t of targets) {
    if (_globalDiscogStop) break;
    if (status) status.textContent = `${done}/${targets.length} — ${t.artist}`;
    try {
      await new Promise(r => setTimeout(r, 1100));
      const sRes = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent('artist:"' + t.artist + '"')}&fmt=json&limit=5`);
      if (!sRes.ok) throw new Error('HTTP ' + sRes.status);
      const sData = await sRes.json();
      const best = (sData.artists || [])[0];
      if (best) {
        await new Promise(r => setTimeout(r, 1100));
        const rRes = await fetch(`https://musicbrainz.org/ws/2/release-group?artist=${best.id}&type=album|ep&limit=100&fmt=json`);
        if (!rRes.ok) throw new Error('HTTP ' + rRes.status);
        const rData = await rRes.json();
        const groups = (rData['release-groups'] || []).filter(g => !((g['secondary-types'] || []).some(s => DISCOG_SCAN_EXCLUDED_SECONDARY.includes(s))));
        const artVariants = artistVariants(t.artist);
        const ownedTitles = new Set();
        albums.forEach(a => {
          if ([...artistVariants(a.artist)].some(v => artVariants.has(v))) ownedTitles.add(normalizeKey('', a.album).replace('|||', ''));
        });
        const missing = groups.filter(g => { const key = normalizeKey('', g.title || '').replace('|||', ''); return key && !ownedTitles.has(key); });
        const total = groups.length;
        if (total) {
          const pct = Math.round(((total - missing.length) / total) * 100);
          _globalDiscogResults.push({ artist: t.artist, albumId: t.albumId, owned: t.count, total, missing: missing.length, pct });
        }
      }
    } catch (e) { console.warn('scanAllMissingDiscography:', t.artist, e.message || e); }
    done++;
    if (done % 5 === 0) renderAuditDiscogCompletion();
  }
  _globalDiscogScanning = false;
  if (btn) { btn.textContent = `🔍 Scanner la discographie (${targets.length} artistes, ~${Math.ceil(targets.length * 2.4 / 60)} min)`; btn.onclick = scanAllMissingDiscography; }
  if (status) status.textContent = `${_globalDiscogStop ? 'Arrêté' : 'Terminé'} — ${done}/${targets.length} artiste(s) analysé(s).`;
  renderAuditDiscogCompletion();
}

function renderAuditDiscogCompletion() {
  const el = document.getElementById('audit-discog-list');
  if (!el) return;
  const sorted = [..._globalDiscogResults].filter(r => r.missing > 0).sort((a, b) => a.pct - b.pct);
  if (!sorted.length) {
    el.innerHTML = `<div class="empty" style="padding:16px"><div class="empty-icon">🕸️</div>${_globalDiscogResults.length ? 'Toutes les discographies scannées sont complètes.' : "Lance le scan pour voir les artistes avec des trous."}</div>`;
    return;
  }
  el.innerHTML = sorted.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="editAlbum('${sid(r.albumId)}');setTimeout(()=>searchMissingDiscography(),80)">
    <div><div style="font-weight:500">${esc(r.artist)}</div><div style="font-size:11px;color:var(--text3)">${r.owned} possédé(s) / ${r.total} sur MusicBrainz</div></div>
    <div style="text-align:right"><span style="font-family:var(--mono);color:${r.pct < 50 ? 'var(--red)' : 'var(--amber)'}">${r.pct}%</span><div style="font-size:11px;color:var(--text3)">${r.missing} manquant(s)</div></div>
  </div>`).join('');
}

function renderAudit() {
  renderAuditMbScores();
  renderAuditRymDivergence();
  renderAuditSourceDivergences();
  renderAuditDiscogCompletion();
  const cmpBtn = document.getElementById('audit-cmp-scan-btn');
  if (cmpBtn && !_globalCmpScanning) cmpBtn.textContent = `🔍 Scanner les divergences (${sourceDivergenceEligibleAlbums().length} albums)`;
  const discogBtn = document.getElementById('audit-discog-scan-btn');
  if (discogBtn && !_globalDiscogScanning) {
    const n = ownedArtistsList().length;
    discogBtn.textContent = `🔍 Scanner la discographie (${n} artistes, ~${Math.ceil(n * 2.4 / 60)} min)`;
  }
}

// ===================== IMPORT/EXPORT — SOUS-ONGLETS =====================
// Demandé par Antoine : bascule "Associations" (ex-onglet top-level dédié) dans Import/Export,
// et ajoute un nouveau sous-onglet "IDs manquants". Même pattern de bascule que Session
// notation (boutons covers-filter-btn) plutôt qu'un vrai système de nav — ce sont 3 vues
// mutuellement exclusives DANS le même écran, pas 3 destinations de navigation distinctes.
function switchImportTab(tab) {
  ['sources', 'assoc', 'missingids'].forEach(t => {
    const el = document.getElementById('import-tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
    const btn = document.getElementById('import-tab-btn-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'assoc') renderAssocReview();
  if (tab === 'missingids') renderMissingIds();
}

// ===================== IDs MANQUANTS =====================
// Demandé par Antoine : albums sans discogsId NI mb_release_id, et morceaux isolés sans
// mb_recording_id — avec une interface de recherche (MusicBrainz, en direct, résultats
// cliquables) ou de collage manuel d'un ID (Discogs ou MBID).
// MusicBrainz : recherche live via l'API publique (release pour un album, recording pour un
// morceau) — même principe que la recherche artiste de "Discographie manquante", aucun
// changement d'Edge Function nécessaire. Discogs : pas de recherche live possible sans passer
// par l'Edge Function (CORS + token) — get-release-info.ts n'a actuellement qu'un mode "fetch
// par ID connu", pas de mode recherche. Plutôt que de supposer un endpoint qui n'existe peut-
// être pas, on ouvre la recherche Discogs.com dans un nouvel onglet (préremplie) et on colle
// l'ID trouvé manuellement — fonctionne immédiatement, sans dépendre d'un déploiement Edge
// Function supplémentaire. Un vrai mode recherche Discogs pourrait être ajouté plus tard côté
// Edge Function si utile (branche "discogs_search" sur /database/search).
function albumsWithoutIds() {
  return albums.filter(a => !a.discogsId && !a.mb_release_id);
}
function tracksWithoutMbid() {
  return tracks.filter(t => !t.mb_recording_id);
}

function renderMissingIds() {
  const q = (document.getElementById('filter-missingids-q')?.value || '').toLowerCase().trim();
  const albumRows = albumsWithoutIds().filter(a => !q || (a.artist + ' ' + a.album).toLowerCase().includes(q));
  const trackRows = tracksWithoutMbid().filter(t => !q || (t.artist + ' ' + t.title).toLowerCase().includes(q));

  const badge = document.getElementById('import-missingids-badge');
  if (badge) badge.textContent = albumsWithoutIds().length + tracksWithoutMbid().length;
  const ac = document.getElementById('missingids-albums-counter');
  if (ac) ac.textContent = `(${albumRows.length})`;
  const tc = document.getElementById('missingids-tracks-counter');
  if (tc) tc.textContent = `(${trackRows.length})`;

  const albumsTbody = document.getElementById('missingids-albums-tbody');
  if (albumsTbody) {
    const slice = albumRows.slice(0, 200);
    albumsTbody.innerHTML = slice.map(a => `<tr>
      <td><div style="font-weight:500">${esc(a.album)}</div><div style="font-size:11px;color:var(--text3)">${esc(a.artist)}</div></td>
      <td class="mono">${a.year || '–'}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-sm" onclick="openLinkIdModal('album','${sid(a.id)}','mb_release_id')">🔍 MusicBrainz</button>
        <button class="btn btn-sm" onclick="openLinkIdModal('album','${sid(a.id)}','discogsId')">🔗 Discogs</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="3"><div class="empty" style="padding:20px"><div class="empty-icon">✅</div>${q ? 'Aucun résultat pour ce filtre.' : 'Tous les albums ont un ID Discogs ou MusicBrainz.'}</div></td></tr>`;
    if (albumRows.length > 200) albumsTbody.innerHTML += `<tr><td colspan="3" style="text-align:center;color:var(--text3);font-size:12px;padding:10px">… et ${(albumRows.length - 200).toLocaleString('fr-FR')} autres — affine la recherche</td></tr>`;
  }

  const tracksTbody = document.getElementById('missingids-tracks-tbody');
  if (tracksTbody) {
    const slice = trackRows.slice(0, 200);
    tracksTbody.innerHTML = slice.map(t => `<tr>
      <td><div style="font-weight:500">${esc(t.title)}</div><div style="font-size:11px;color:var(--text3)">${esc(t.artist)}</div></td>
      <td><button class="btn btn-sm" onclick="openLinkIdModal('track','${sid(t.id)}','mb_recording_id')">🔍 MusicBrainz</button></td>
    </tr>`).join('') || `<tr><td colspan="2"><div class="empty" style="padding:20px"><div class="empty-icon">✅</div>${q ? 'Aucun résultat pour ce filtre.' : 'Tous les morceaux isolés ont un MBID.'}</div></td></tr>`;
    if (trackRows.length > 200) tracksTbody.innerHTML += `<tr><td colspan="2" style="text-align:center;color:var(--text3);font-size:12px;padding:10px">… et ${(trackRows.length - 200).toLocaleString('fr-FR')} autres — affine la recherche</td></tr>`;
  }
}

// ── Modale de liaison (recherche MusicBrainz live ou collage manuel) ──────────────────────
let _linkIdTarget = null; // { type:'album'|'track', id, artist, title, field }
let _linkIdResults = [];

async function openLinkIdModal(type, idSid, field) {
  const id = unsid(idSid);
  const entity = type === 'album' ? albums.find(a => a.id === id) : tracks.find(t => t.id === id);
  if (!entity) return;
  const artist = entity.artist;
  const title = type === 'album' ? entity.album : entity.title;
  _linkIdTarget = { type, id, artist, title, field };

  document.getElementById('link-id-modal-title').textContent = field === 'discogsId' ? '🔗 Lier à Discogs' : '🆔 Lier à MusicBrainz';
  document.getElementById('link-id-title').textContent = `${artist} — ${title}`;
  document.getElementById('link-id-manual').value = '';

  const discogsLink = document.getElementById('link-id-discogs-link');
  const manualLabel = document.getElementById('link-id-manual-label');

  // Le lien externe Discogs.com reste affiché même avec la recherche intégrée — utile en
  // repli si la recherche ne trouve pas la bonne édition précise (variante/pressage).
  discogsLink.style.display = field === 'discogsId' ? 'inline-block' : 'none';
  if (field === 'discogsId') {
    discogsLink.href = `https://www.discogs.com/search/?q=${encodeURIComponent(artist + ' ' + title)}&type=release`;
  }
  manualLabel.textContent = field === 'discogsId'
    ? 'Ou coller l\'ID Discogs manuellement (numérique, trouvé dans l\'URL de la release)'
    : 'Ou coller un MBID MusicBrainz manuellement';

  document.getElementById('modal-link-id').classList.add('open');
  await searchLinkIdResults();
}

// Recherche unifiée — 3 chemins selon le champ à lier : Discogs (Edge Function, v2026.07.12-18)
// et MusicBrainz release (Edge Function, réutilise searchMusicBrainz() déjà existant) passent
// par le serveur (auth Discogs / rate-limit MusicBrainz géré côté Edge Function) ; MusicBrainz
// recording (morceaux) reste en appel direct côté client — l'API MusicBrainz publique est
// directement joignable sans CORS pour la recherche (déjà le cas ailleurs dans l'app, ex.
// Discographie manquante) et il n'existe pas encore de branche Edge Function pour ça.
// Les résultats sont normalisés en {resultId, title, subtitle} quelle que soit la source, pour
// un rendu et une application uniques (applyLinkIdResult).
async function searchLinkIdResults() {
  const t = _linkIdTarget;
  if (!t) return;
  const resEl = document.getElementById('link-id-mb-results');
  resEl.style.display = 'block';
  const sourceLabel = t.field === 'discogsId' ? 'Discogs' : 'MusicBrainz';
  resEl.innerHTML = `<div style="padding:12px;color:var(--text3);font-size:12px">Recherche ${sourceLabel}…</div>`;
  try {
    let normalized = [];
    if (t.field === 'discogsId') {
      const results = await searchDiscogs(t.artist, t.title);
      normalized = results.map(r => ({
        resultId: r.id,
        title: r.title,
        subtitle: [r.year, r.format, r.label, r.country].filter(Boolean).join(' · '),
      }));
    } else if (t.field === 'mb_release_id') {
      const results = await searchMusicBrainz(t.artist, t.title);
      normalized = results.map(r => ({
        resultId: r.mb_release_id,
        title: r.title + (r.disambiguation ? ` — ${r.disambiguation}` : ''),
        subtitle: [r.artist, r.release_date, r.country, r.label].filter(Boolean).join(' · '),
      }));
    } else { // mb_recording_id — appel direct MusicBrainz public, pas de branche Edge Function
      const q = `artist:"${t.artist}" AND recording:"${t.title}"`;
      const res = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=10`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      normalized = (data.recordings || []).map(r => ({
        resultId: r.id,
        title: r.title + (r.disambiguation ? ` — ${r.disambiguation}` : ''),
        subtitle: [(r['artist-credit'] || []).map(c => c.name).join(', '), r.length ? Math.round(r.length/1000)+'s' : ''].filter(Boolean).join(' · '),
      }));
    }
    _linkIdResults = normalized;
    if (!normalized.length) {
      resEl.innerHTML = `<div style="padding:12px;color:var(--text3);font-size:12px">Aucun résultat ${sourceLabel} — essaie de coller un ID manuellement ci-dessous.</div>`;
      return;
    }
    resEl.innerHTML = normalized.map((r, i) => `<div style="padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="applyLinkIdResult(${i})">
        <div style="font-weight:500;font-size:13px">${esc(r.title)}</div>
        <div style="font-size:11px;color:var(--text3)">${esc(r.subtitle)}</div>
      </div>`).join('');
  } catch (e) {
    resEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px">Erreur ${sourceLabel} : ${esc(e.message || e)}${t.field === 'discogsId' ? ' — vérifie que la branche discogs_search est bien déployée sur l\'Edge Function' : ''}</div>`;
  }
}

function applyLinkIdResult(i) {
  const r = _linkIdResults[i];
  if (!r) return;
  applyLinkId(r.resultId);
}

function applyLinkIdManual() {
  const val = (document.getElementById('link-id-manual').value || '').trim();
  if (!val) return;
  applyLinkId(val);
}

function applyLinkId(value) {
  const t = _linkIdTarget;
  if (!t) return;
  const entity = t.type === 'album' ? albums.find(a => a.id === t.id) : tracks.find(x => x.id === t.id);
  if (!entity) return;
  entity[t.field] = value;
  invalidateCache();
  saveToStorage();
  closeLinkIdModal();
  renderMissingIds();
  toast(`Lié : ${t.artist} — ${t.title}${t.type === 'album' ? ' — ouvre la fiche pour rafraîchir les métadonnées' : ''}`);
  if (t.type === 'album') editAlbum(sid(t.id));
}

function closeLinkIdModal() {
  document.getElementById('modal-link-id').classList.remove('open');
  _linkIdTarget = null;
}
document.getElementById('modal-link-id').addEventListener('click', function(e) {
  if (e.target === this) closeLinkIdModal();
});

// ===================== VUE ARTISTE =====================
// Demandé par Antoine suite à une discussion sur "Divergences Discogs/MusicBrainz" et
// "Complétion de discographie" (Audit collection) : une vue centrée sur UN artiste, qui
// s'appuie sur MusicBrainz pour lister toute sa discographie (albums possédés ET manquants)
// et y rapatrie ce que l'app sait déjà (note perso, note RYM, écoutes last.fm, statut wishlist).
// Réutilise le même pattern de fetch que searchMissingDiscography() (recherche artiste puis
// release-groups, 2 appels MusicBrainz publics non-authentifiés) mais construit une liste
// FUSIONNÉE (pas juste les manquants) avec les stats déjà en mémoire côté possédé/RYM/last.fm.
// Chargement automatique à l'ouverture de la vue (à la demande d'Antoine) — contrairement aux
// scans en masse de l'Audit, une recherche par artiste ne coûte que 2 requêtes, un délai à
// l'ouverture reste raisonnable.
// Nom d'artiste cliquable → ouvre la Vue Artiste. stopPropagation() systématique car utilisé
// dans des lignes de tableau qui ont elles-mêmes un onclick (ouverture de la fiche album) —
// cliquer spécifiquement sur le nom doit ouvrir la Vue Artiste, pas la fiche.
function artistLink(name) {
  if (!name) return '';
  return `<span onclick="event.stopPropagation();openArtistView('${sid(name)}')" style="cursor:pointer" title="Voir la Vue Artiste">${esc(name)}</span>`;
}

let _artistViewData = null; // { mbArtist, rows, stats, notFound }
let _artistViewLoading = false;

// Agrégats côté données déjà en mémoire (albums possédés, écoutes, notes) pour cet artiste —
// toutes variantes de nom confondues (artistVariants(), même mécanisme que le reste de l'app).
function computeArtistAggregates(artist) {
  const variants = artistVariants(artist);
  const inVariants = (name) => [...artistVariants(name)].some(v => variants.has(v));
  const ownedAlbums = albums.filter(a => a.artist && inVariants(a.artist));
  const albumPlays = ownedAlbums.reduce((s, a) => s + (a.plays || 0), 0);
  const trackPlays = Object.values(_lastfmTrackCounts).filter(t => inVariants(t.artist)).reduce((s, t) => s + (t.plays || 0), 0);
  const rated = ownedAlbums.filter(a => a.note);
  return {
    ownedCount: ownedAlbums.length,
    totalPlays: albumPlays + trackPlays,
    avgNote: rated.length ? rated.reduce((s, a) => s + a.note, 0) / rated.length : null,
    ratedCount: rated.length,
    genres: [...new Set(ownedAlbums.map(a => a.genre).filter(Boolean))],
  };
}

async function openArtistView(artistSid) {
  const artist = unsid(artistSid);
  nav('artistview');
  const input = document.getElementById('av-search');
  if (input) input.value = artist;
  await loadArtistView(artist);
}

async function searchArtistView() {
  const artist = (document.getElementById('av-search')?.value || '').trim();
  if (!artist) return;
  await loadArtistView(artist);
}

async function loadArtistView(artist) {
  if (!artist || _artistViewLoading) return;
  _artistViewLoading = true;
  _artistViewData = null;
  renderArtistView(); // affiche l'état "chargement"
  try {
    const sRes = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent('artist:"' + artist + '"')}&fmt=json&limit=5`);
    if (!sRes.ok) throw new Error('MusicBrainz indisponible (HTTP ' + sRes.status + ')');
    const sData = await sRes.json();
    const best = (sData.artists || [])[0];
    if (!best) { _artistViewData = { notFound: true, query: artist }; return; }

    await new Promise(r => setTimeout(r, 1100)); // limite MusicBrainz non-authentifiée ~1 req/s
    const rRes = await fetch(`https://musicbrainz.org/ws/2/release-group?artist=${best.id}&type=album|ep&limit=100&fmt=json`);
    if (!rRes.ok) throw new Error('MusicBrainz indisponible (HTTP ' + rRes.status + ')');
    const rData = await rRes.json();
    const groups = (rData['release-groups'] || []).filter(g => !((g['secondary-types'] || []).some(s => DISCOG_SCAN_EXCLUDED_SECONDARY.includes(s))));

    const variants = artistVariants(artist);
    const inVariants = (name) => [...artistVariants(name)].some(v => variants.has(v));
    const ownedByTitle = new Map();
    albums.forEach(a => { if (a.artist && inVariants(a.artist)) ownedByTitle.set(normalizeKey('', a.album).replace('|||', ''), a); });
    const wishByTitle = new Set(wishlist.filter(w => inVariants(w.artist)).map(w => normalizeKey('', w.album).replace('|||', '')));
    const lfByTitle = new Map();
    lastfmData.forEach(d => { if (inVariants(d.artist)) lfByTitle.set(normalizeKey('', d.album).replace('|||', ''), d.plays || 0); });

    const rows = groups.map(g => {
      const key = normalizeKey('', g.title || '').replace('|||', '');
      const album = ownedByTitle.get(key);
      const rymEntry = album ? lookupRym(album.artist, album.album, album.id) : lookupRym(artist, g.title);
      return {
        title: g.title,
        year: (g['first-release-date'] || '').slice(0, 4),
        type: g['primary-type'] || '',
        owned: !!album,
        albumId: album?.id || null,
        note: album?.note || 0,
        rymRating: rymEntry?.rating || 0,
        plays: album ? (album.plays || 0) : (lfByTitle.get(key) || 0),
        wishlisted: !album && wishByTitle.has(key),
      };
    }).sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));

    _artistViewData = { mbArtist: best, rows, stats: computeArtistAggregates(artist), query: artist };
  } catch (e) {
    console.error('loadArtistView:', e);
    _artistViewData = { error: e.message || String(e), query: artist };
  } finally {
    _artistViewLoading = false;
    renderArtistView();
  }
}

function renderArtistView() {
  const el = document.getElementById('av-content');
  if (!el) return;
  if (_artistViewLoading) {
    el.innerHTML = '<div class="empty" style="padding:40px"><div class="empty-icon">🎤</div>Recherche MusicBrainz…</div>';
    return;
  }
  if (!_artistViewData) {
    el.innerHTML = '<div class="empty" style="padding:40px"><div class="empty-icon">🎤</div>Cherche un artiste ci-dessus, ou clique sur un nom d\'artiste n\'importe où dans l\'app.</div>';
    return;
  }
  if (_artistViewData.notFound) {
    el.innerHTML = `<div class="empty" style="padding:40px"><div class="empty-icon">🔍</div>Artiste introuvable sur MusicBrainz pour "${esc(_artistViewData.query)}".</div>`;
    return;
  }
  if (_artistViewData.error) {
    el.innerHTML = `<div class="empty" style="padding:40px"><div class="empty-icon">⚠️</div>Erreur MusicBrainz : ${esc(_artistViewData.error)}</div>`;
    return;
  }

  const { mbArtist, rows, stats, query } = _artistViewData;
  const total = rows.length;
  const pct = total ? Math.round(stats.ownedCount / total * 100) : 0;

  const header = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div>
          <h3 style="margin:0;font-size:18px">${esc(mbArtist.name)}</h3>
          <div style="font-size:12px;color:var(--text3)">${esc(mbArtist.disambiguation || mbArtist.type || '')}</div>
        </div>
        <button class="btn btn-sm" onclick="document.getElementById('artistlinks-search').value=${JSON.stringify(query)};nav('artistlinks');renderArtistLinks()" title="Voir les collaborations connues avec d'autres artistes de ta collection">🕸️ Artistes similaires</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;text-align:center">
        <div><div style="font-size:20px;font-weight:600;color:var(--accent)">${stats.ownedCount}/${total}</div><div style="font-size:11px;color:var(--text3)">possédés (${pct}%)</div></div>
        <div><div style="font-size:20px;font-weight:600">${stats.totalPlays.toLocaleString('fr-FR')}</div><div style="font-size:11px;color:var(--text3)">écoutes last.fm</div></div>
        <div><div style="font-size:20px;font-weight:600">${stats.avgNote != null ? stats.avgNote.toFixed(1) + '★' : '–'}</div><div style="font-size:11px;color:var(--text3)">note moy. (${stats.ratedCount})</div></div>
        <div><div style="font-size:20px;font-weight:600">${stats.genres.length}</div><div style="font-size:11px;color:var(--text3)">${esc(stats.genres.slice(0,2).join(', ')) || 'genre(s)'}</div></div>
        <div><div style="font-size:20px;font-weight:600">${total}</div><div style="font-size:11px;color:var(--text3)">albums/EP MusicBrainz</div></div>
      </div>
    </div>`;

  const list = rows.map(r => {
    const badges = [];
    if (r.owned) badges.push('<span class="badge" style="background:rgba(100,220,100,0.08);color:#6ddc6d;border-color:rgba(100,220,100,0.25)">✅ Possédé</span>');
    else badges.push('<span class="badge">⬜ Manquant</span>');
    if (r.wishlisted) badges.push('<span class="badge" style="background:rgba(255,105,180,0.08);color:#ff8ecb;border-color:rgba(255,105,180,0.25)">🎯 Wishlist</span>');
    if (r.type === 'EP') badges.push('<span class="badge">EP</span>');
    const noteStr = r.note ? `${r.note.toFixed(1)}★ perso` : '';
    const rymStr = r.rymRating ? `${r.rymRating.toFixed(2)}★ RYM` : '';
    const playsStr = r.plays ? `${r.plays.toLocaleString('fr-FR')} écoutes` : '';
    const metaParts = [noteStr, rymStr, playsStr].filter(Boolean).join(' · ');
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);${r.owned ? 'cursor:pointer' : ''}" ${r.owned ? `onclick="editAlbum('${sid(r.albumId)}')"` : ''}>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500">${esc(r.title)}${r.year ? ` <span style="color:var(--text3);font-weight:400">(${esc(r.year)})</span>` : ''}</div>
        <div style="display:flex;gap:6px;margin-top:3px">${badges.join('')}</div>
      </div>
      <div style="font-size:12px;color:var(--text2);text-align:right;white-space:nowrap">${metaParts}</div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:24px">Aucun album/EP trouvé sur MusicBrainz pour cet artiste.</div>';

  el.innerHTML = header + `<div class="card">${list}</div>`;
}

// ===================== PWA — ENREGISTREMENT DU SERVICE WORKER =====================
// Todo section 11 : « PWA installable (manifest + service worker minimal) pour un accès
// mobile plus fluide que l'export HTML offline actuel, sans refonte d'architecture ».
// Portée réduite au shell statique (voir sw.js) — Supabase/API externes ne sont jamais
// interceptées, donc les données restent toujours en ligne réelles, jamais du cache périmé.
// Chemin relatif ('./sw.js') : fonctionne aussi bien à la racine du domaine GitHub Pages
// (terant2025.github.io si domaine dédié) que sous un sous-chemin (terant2025.github.io/
// music-collection/), contrairement à un chemin absolu qui casserait le 2e cas.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => {
      console.warn('Service worker non enregistré (PWA installable indisponible, reste utilisable normalement) —', e.message || e);
    });
  });
}


