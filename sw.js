// Service worker minimal pour rendre l'app installable (PWA) — todo section 11, item ⬜
// « PWA installable (manifest + service worker minimal) pour un accès mobile plus fluide que
// l'export HTML offline actuel, sans refonte d'architecture ».
//
// Portée volontairement réduite : met en cache uniquement l'app shell statique (HTML/CSS/JS/
// icônes, même origine que GitHub Pages) pour un chargement instantané et un minimum de
// fonctionnement hors-ligne (l'UI s'affiche, mais Supabase/last.fm/Discogs/MusicBrainz restent
// nécessaires pour toute donnée réelle — pas d'offline complet, l'export HTML autonome existant
// reste la solution pour une consultation 100% déconnectée).
//
// AUCUNE interception des requêtes vers Supabase ou les API externes (last.fm, Discogs,
// MusicBrainz, YouTube, l'Edge Function) : uniquement les requêtes GET de même origine sont
// concernées. Servir une réponse Supabase mise en cache serait pire que ne rien servir du
// tout (données périmées silencieusement présentées comme à jour).
//
// ⚠️ CACHE_VERSION à incrémenter à CHAQUE déploiement (même convention manuelle que
// APP_VERSION dans index.html) — sinon les anciens visiteurs restent bloqués sur le shell mis
// en cache précédemment tant qu'ils n'ont pas fermé tous les onglets de l'app.
const CACHE_VERSION = 'v2026.07.10-32';
const CACHE_NAME = `discotheque-shell-${CACHE_VERSION}`;

const SHELL_FILES = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith('discotheque-shell-') && n !== CACHE_NAME)
             .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Uniquement GET, même origine — tout le reste (Supabase, CDN, API externes, POST/PATCH)
  // passe directement au réseau, non intercepté.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Stale-while-revalidate : sert le cache immédiatement si présent (chargement instantané),
  // relance quand même une requête réseau en tâche de fond pour rafraîchir le cache — la
  // prochaine visite aura donc la version à jour, sans jamais bloquer l'affichage sur le réseau.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached); // hors-ligne et rien en cache → laisse l'erreur réseau remonter via cached (peut être undefined)
        return cached || network;
      })
    )
  );
});
