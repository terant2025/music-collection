#!/usr/bin/env node
// Tests de non-régression pour normalizeKey() — à lancer avant chaque déploiement :
//   node test-normalizeKey.js index.html
// Extrait la fonction DIRECTEMENT depuis index.html (pas une copie qui pourrait diverger
// silencieusement du code réel) et vérifie les cas déjà rencontrés en production.

const fs = require('fs');

const filePath = process.argv[2] || 'index.html';
const src = fs.readFileSync(filePath, 'utf8');

function extractFunction(source, name) {
  const startMarker = `function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Fonction ${name} introuvable dans ${filePath}`);
  let i = source.indexOf('{', start);
  let depth = 0, end = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end);
}

const normalizeKeySrc = extractFunction(src, 'normalizeKey');
eval(normalizeKeySrc); // définit normalizeKey() dans ce scope, à partir du code réel du fichier

let pass = 0, fail = 0;
function sameKey(desc, a1, b1, a2, b2) {
  const k1 = normalizeKey(a1, b1), k2 = normalizeKey(a2, b2);
  if (k1 === k2) { pass++; }
  else { fail++; console.error(`❌ ${desc}\n   "${a1}" / "${b1}" → ${k1}\n   "${a2}" / "${b2}" → ${k2}`); }
}
function diffKey(desc, a1, b1, a2, b2) {
  const k1 = normalizeKey(a1, b1), k2 = normalizeKey(a2, b2);
  if (k1 !== k2) { pass++; }
  else { fail++; console.error(`❌ ${desc}\n   les deux clés sont IDENTIQUES alors qu'elles devraient différer : "${k1}"`); }
}

// ── & vs and ──
sameKey('& / and équivalents', 'Belle & Sebastian', 'Dear Catastrophe Waitress', 'Belle and Sebastian', 'Dear Catastrophe Waitress');

// ── Casse ──
sameKey('Casse insensible', 'RADIOHEAD', 'OK Computer', 'radiohead', 'ok computer');

// ── Apostrophes typographiques vs ASCII ──
sameKey('Apostrophe typographique vs ASCII', 'Guns N\u2019 Roses', 'Appetite for Destruction', "Guns N' Roses", 'Appetite for Destruction');

// ── Diacritiques ──
sameKey('Diacritiques (é vs e)', 'Beyoncé', 'Renaissance', 'Beyonce', 'Renaissance');

// ── Tirets longs vs simples ──
sameKey('Tiret cadratin vs simple', 'Artist \u2013 Name', 'Album', 'Artist - Name', 'Album');

// ── feat./ft. entre parenthèses ignoré ──
sameKey('feat. entre parenthèses ignoré', 'Artist', 'Song (feat. Someone)', 'Artist', 'Song');
sameKey('ft. entre parenthèses ignoré', 'Artist', 'Song (ft. Someone)', 'Artist', 'Song');

// ── feat. en fin de titre sans parenthèses ──
sameKey('feat. sans parenthèses en fin', 'Artist', 'Song feat. Someone', 'Artist', 'Song');

// ── remaster / live / bonus track ignorés ──
sameKey('remaster ignoré', 'Artist', 'Album (Remastered)', 'Artist', 'Album');
sameKey('live ignoré', 'Artist', 'Album [Live]', 'Artist', 'Album');
sameKey('bonus track ignoré', 'Artist', 'Album (Bonus Track Version)', 'Artist', 'Album');

// ── Année entre parenthèses ignorée ──
sameKey('année entre parenthèses ignorée', 'Artist', 'Album (2015)', 'Artist', 'Album');

// ── Guillemets typographiques ignorés ──
sameKey('Guillemets « » ignorés', '\u00abArtist\u00bb', 'Album', 'Artist', 'Album');

// ── Ellipsis unicode vs points ──
sameKey('Ellipsis unicode vs points', 'Artist', 'Album\u2026', 'Artist', 'Album...');

// ── Cas qui NE DOIVENT PAS fusionner (garde-fous anti faux-positifs) ──
diffKey('Deux albums différents du même artiste restent différents', 'Radiohead', 'OK Computer', 'Radiohead', 'Kid A');
diffKey('Deux artistes différents, même titre, restent différents', 'Artist One', 'Greatest Hits', 'Artist Two', 'Greatest Hits');
diffKey('Album et sa suite (mbv) restent distincts', 'My Bloody Valentine', 'Loveless', 'My Bloody Valentine', 'mbv');

console.log(`\n${pass} test(s) réussi(s), ${fail} échec(s) — sur ${filePath}`);
process.exit(fail ? 1 : 0);
