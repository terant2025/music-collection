// À ajouter dans ta fonction Supabase existante `get-release-info`, dans le bloc de
// dispatch selon `source` (aux côtés de 'discogs' et 'musicbrainz'). Adapte les noms de
// variables à ton code existant (ex: si tu lis les query params autrement).
//
// IMPORTANT sécurité : qobuz_token vient du client (localStorage de l'utilisateur), jamais
// stocké côté serveur — on le relaie simplement à Qobuz pour cette requête.
//
// NON TESTÉ EN CONDITIONS RÉELLES : je n'ai pas d'accès réseau à api Qobuz pour valider ce
// code contre l'API live. Le format des endpoints (track/search, album/search) et le nom
// des champs de réponse (title, performer.name, album.image, etc.) suivent la documentation
// publique connue de l'API REST Qobuz v0.2, mais si un champ ne correspond pas exactement,
// ajuste le mapping ci-dessous après avoir inspecté une réponse réelle (console.log(data)).

if (source === 'qobuz') {
  const type       = params.get('type');        // 'track' ou 'album'
  const query      = params.get('query');
  const qobuzAppId = params.get('qobuz_app_id') || '';
  const qobuzToken = params.get('qobuz_token')  || '';

  if (!qobuzToken) {
    return new Response(JSON.stringify({ error: 'Token Qobuz manquant' }), { status: 400 });
  }

  const endpoint = type === 'track' ? 'track/search' : 'album/search';
  const url = `https://www.qobuz.com/api.json/0.2/${endpoint}?query=${encodeURIComponent(query)}&limit=15`
    + (qobuzAppId ? `&app_id=${encodeURIComponent(qobuzAppId)}` : '');

  const qobuzRes = await fetch(url, {
    headers: {
      'X-User-Auth-Token': qobuzToken,
      ...(qobuzAppId ? { 'X-App-Id': qobuzAppId } : {}),
    },
  });

  if (!qobuzRes.ok) {
    // Qobuz répond souvent 401 si app_id manquant/invalide, ou 400 si la requête n'est pas
    // signée pour un endpoint qui l'exige — message renvoyé tel quel pour diagnostiquer.
    const errText = await qobuzRes.text();
    return new Response(JSON.stringify({ error: `Qobuz ${qobuzRes.status} : ${errText.slice(0, 300)}` }), { status: 502 });
  }

  const data = await qobuzRes.json();
  const items = type === 'track'
    ? (data.tracks?.items || [])
    : (data.albums?.items || []);

  const results = items.map(it => type === 'track' ? {
    id:     it.id,
    title:  it.title,
    artist: it.performer?.name || it.album?.artist?.name || '',
    album:  it.album?.title || '',
  } : {
    id:     it.id,
    title:  it.title,
    artist: it.artist?.name || '',
    year:   it.release_date_original ? it.release_date_original.slice(0, 4) : '',
  });

  return new Response(JSON.stringify({ results }), { status: 200 });
}
