# Runbook : correctifs TLS après la couche SEO (CT 120)

Deux correctifs nginx sur le **CT 120** (`10.1.20.120`, prod), en **deux phases
séparées** que l'opérateur peut exécuter à des moments différents :

- **Phase 1 : observer.** Ne change aucun comportement. Mesure, de l'intérieur,
  ce que le CT 120 reçoit réellement de NPM. Réversible par la suppression d'un fichier.
- **Phase 2 : appliquer.** À faire **uniquement si la phase 1 confirme la prémisse**
  (le script de verdict l'écrit noir sur blanc).

Rechargement nginx uniquement : **aucun redémarrage de `lucie-cowork.service`**,
donc aucune coupure des sessions ni des paiements en cours.

| | Problème | Correctif |
|---|---|---|
| A | `https://cazalia.fr/tarifs` répond `301 Location: http://cazalia.fr/tarifs/` (retour en clair) | `absolute_redirect off;` : le `Location` devient `/tarifs/` |
| B | `http://cazalia.fr/…` répond 200 en clair (pas de redirection vers https) | `return 302 https://…` si « requête relayée par NPM **et** qui ne déclare **pas** `X-Forwarded-Proto: https` » |

Le modèle de référence est `deploy/nginx.conf`. C'est un **modèle** : il porte les
marqueurs `PROXY_IP_A_RENSEIGNER` et `DOMAINE_A_RENSEIGNER` et `nginx -t` y échoue
volontairement. Le vhost réel du CT 120 porte le vrai `server_name` :
**ne jamais copier le modèle par-dessus le vhost**, on applique seulement les
ajouts décrits en phase 2.

## Pourquoi cette condition, et ce qu'elle coûte

Sondage de la prod depuis l'extérieur (le HSTS applicatif n'est émis que si
`X-Forwarded-Proto` vaut exactement `https` à l'arrivée) :

| requête | en-tête client | XFP reçu par le CT 120 |
|---|---|---|
| `https://cazalia.fr/api/config` | aucun | `https` (posé par NPM) |
| `https://cazalia.fr/api/config` | `XFP: http` | `https` (NPM écrase la valeur du client) |
| `http://cazalia.fr/api/config` | aucun | **absent** (rien ne l'injecte) |
| `http://cazalia.fr/api/config` | `XFP: https` | `https` (valeur du client, intacte) |

Pour un visiteur réel en http, l'en-tête est donc **absent**. Une condition « XFP
vaut `http` » ne se déclenche jamais. La condition retenue est inversée :
**redirection si le pair TCP est NPM et que XFP n'est pas `https`** (absent, vide,
`http` ou autre).

> ⚠️ **Le mode de défaillance est inversé, et c'est le prix à payer.**
> L'ancienne condition, si NPM changeait, donnait un no-op (rien n'était redirigé,
> le site restait servi). Celle-ci échoue **fermé** : si NPM cessait de poser
> `X-Forwarded-Proto: https` sur le chemin 443 (mise à jour de NPM qui régénère
> `proxy.conf`, édition d'un Proxy Host, etc.), **toute requête https serait
> redirigée vers https : boucle de redirection, site inaccessible depuis Internet**
> (le LAN direct reste servi). C'est pourquoi : la phase 1 vérifie la prémisse
> avant tout ; la redirection est en **302** (un 301 serait mis en cache par les
> navigateurs et le retour arrière ne réparerait pas les visiteurs touchés) ; et
> la section « Surveillance » ci-dessous est à rejouer après toute intervention sur NPM.

Autres choix, tous documentés dans `deploy/nginx.conf` :

- La redirection est dans `location / { }` et **non au niveau `server`** : un `if`
  de niveau `server` est évalué avant le choix de la `location` et redirigerait
  `/api/`. Or un `POST` ne survit pas à une redirection : le webhook Stripe
  (`POST /api/webhooks/stripe`) cesserait de créer des réservations, sans erreur
  visible. `/api/` n'est donc **pas** redirigé. Conséquence assumée : un `GET`
  `http://cazalia.fr/api/…` reste servi en clair (HSTS et cookie `Secure` limitent
  l'exposition).
- L'hôte de destination vient d'une **liste blanche** (`cazalia.fr`, `www.cazalia.fr`,
  repli sur `cazalia.fr`), pas de l'en-tête `Host` du client : sinon
  `Host: evil.example.com` produirait `Location: https://evil.example.com/…`
  (redirecteur ouvert). `$server_name` n'aurait pas convenu : il ne vaut que le
  premier nom et renverrait `www` vers le domaine nu.
- On n'utilise pas « Force SSL » de NPM : l'UI n'a pas de certificat attaché (le TLS
  passe par le bloc 443 « attrape-tout » `custom`), et la boucle interne
  `443 → 127.0.0.1:80` arrive en `http` au moteur NPM, qui se redirigerait lui-même.
- L'ancien bloc `server { listen 80; return 301 https://… }` ne doit pas être activé :
  boucle (NPM relaie en clair) et coupure du LAN direct.

## Conventions du runbook

- Chaque bloc `bash <<'EOS' … EOS` est un **script complet**, à coller en une fois,
  en root dans le CT 120 (`pct enter 120` depuis le PVE, ou SSH). Il s'exécute dans
  un sous-shell : un `exit 1` arrête le bloc **sans fermer votre session**. Un
  bloc qui affiche `STOP` n'a rien modifié (ou a lui-même fait le retour arrière,
  c'est dit) : ne pas passer au bloc suivant, remonter le message.
- L'état passe d'un bloc à l'autre par `/root/cazalia-tls.env` (droits 600, aucun secret).
- Aucun `2>/dev/null` dans les diagnostics : une erreur doit rester visible.
- Heure creuse pour la phase 2. Avoir la section « Retour arrière » ouverte dans un autre onglet.

---

# PHASE 1 : observer (aucun changement de comportement)

## 1.1 Repérer le vhost et l'IP du proxy

```bash
bash <<'EOS'
set -u
EXPECTED_PROXY=10.1.20.100
ENVF=/root/cazalia-tls.env
command -v nginx >/dev/null || { echo "STOP: nginx absent du PATH (mauvais conteneur ?)"; exit 1; }
FOUND=$(grep -RlE 'cazalia_proto' /etc/nginx/sites-enabled /etc/nginx/conf.d | xargs -r -n1 readlink -f | sort -u)
[ -n "$FOUND" ] || { echo "STOP: aucun vhost ne contient cazalia_proto"; exit 1; }
[ "$(printf '%s\n' "$FOUND" | wc -l)" -eq 1 ] || { echo "STOP: plusieurs vhosts candidats:"; echo "$FOUND"; exit 1; }
VHOST=$FOUND
[ -f "$VHOST" ] || { echo "STOP: $VHOST n'est pas un fichier"; exit 1; }
PROXY_IP=$(grep -oP '^\s*set_real_ip_from\s+\K[0-9.]+(?=\s*;)' "$VHOST" | sort -u)
[ "$PROXY_IP" = "$EXPECTED_PROXY" ] || { echo "STOP: set_real_ip_from lu = [$PROXY_IP], attendu [$EXPECTED_PROXY] (NPM, CT 100)"; exit 1; }
grep -qE '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf;' /etc/nginx/nginx.conf || { echo "STOP: nginx.conf n'inclut pas conf.d/*.conf"; exit 1; }
nginx -t || { echo "STOP: la configuration actuelle est DÉJÀ invalide, ne rien modifier"; exit 1; }
( umask 077; printf 'VHOST=%q\nPROXY_IP=%q\n' "$VHOST" "$PROXY_IP" > "$ENVF" )
echo "OK  VHOST=$VHOST  PROXY_IP=$PROXY_IP"
EOS
```

Attendu : `OK  VHOST=/etc/nginx/sites-available/…  PROXY_IP=10.1.20.100`.

## 1.2 Poser le journal d'observation (temporaire)

Un `log_format` nginx qui journalise le pair TCP réel, `X-Forwarded-Proto` et l'URI.
**Pas de capture réseau** : sur le segment NPM → CT 120, qui est en clair, un
`tcpdump -A` enregistrerait les cookies de session, le jeton de webhook Brevo
(dans l'URL) et les corps de `POST /api/auth/login`, donc des mots de passe.
Ici seuls des champs d'en-tête sont écrits. L'URI est celle que l'`access.log`
standard contient déjà ; ne pas coller ce journal dans un ticket.

```bash
bash <<'EOS'
set -u
ENVF=/root/cazalia-tls.env
[ -r "$ENVF" ] || { echo "STOP: $ENVF absent, rejouer 1.1"; exit 1; }
. "$ENVF"
OBS=/etc/nginx/conf.d/cazalia-phase1-observe.conf
[ -e "$OBS" ] && { echo "STOP: $OBS existe déjà (phase 1 déjà posée)"; exit 1; }
cat > "$OBS" <<'EOF'
# TEMPORAIRE (phase 1 du runbook correctifs-tls-seo). Aucun effet sur les réponses.
log_format cazalia_obs '$time_iso8601\t$realip_remote_addr\t$http_x_forwarded_proto\t$status\t$request_method\t$request_uri';
access_log /var/log/nginx/cazalia-observe.log cazalia_obs;
EOF
undo() { rm -f "$OBS"; nginx -t && systemctl reload nginx; }
nginx -t || { echo "STOP: nginx -t KO, fichier retiré"; undo; exit 1; }
systemctl reload nginx || { echo "STOP: reload KO, fichier retiré"; undo; exit 1; }
echo "OK journal d'observation actif : /var/log/nginx/cazalia-observe.log"
EOS
```

Retour arrière de la phase 1 (à tout moment) : un fichier.

```bash
rm -f /etc/nginx/conf.d/cazalia-phase1-observe.conf && nginx -t && systemctl reload nginx && echo phase1-retiree
```

## 1.3 Générer le trafic de test (depuis un poste, pas depuis le CT)

```bash
RID=$(date +%s); echo "RID=$RID"
curl -sS -o /dev/null -w 'https -> %{http_code}\n' "https://cazalia.fr/?obs=https-$RID"
curl -sS -o /dev/null -w 'http  -> %{http_code}\n' "http://cazalia.fr/?obs=http-$RID"
```

Noter `RID`. Laisser tourner quelques minutes si l'on veut aussi voir du trafic réel.

## 1.4 Lire ce que le CT 120 a reçu

Dans le CT 120 (remplacer `<RID>` par la valeur notée) :

```bash
bash -s -- <RID> <<'EOS'
set -u
RID=${1:?RID manquant}
ENVF=/root/cazalia-tls.env
[ -r "$ENVF" ] || { echo "STOP: $ENVF absent"; exit 1; }
. "$ENVF"
LOG=/var/log/nginx/cazalia-observe.log
[ -s "$LOG" ] || { echo "STOP: journal vide ou absent. Le vhost a probablement son propre access_log (qui masque celui de conf.d), ou le trafic ne passe pas par ce CT."; exit 1; }
echo "--- tes deux visites ---"
awk -F'\t' '$6 ~ /obs=/ { print $1, "pair=" $2, "XFP=" $3, "status=" $4, substr($6,1,40) }' "$LOG" | grep -F -- "-$RID" || true
H=$(awk -F'\t' -v r="obs=https-$RID" 'index($6,r){print $2" "$3}' "$LOG" | tail -1)
P=$(awk -F'\t' -v r="obs=http-$RID"  'index($6,r){print $2" "$3}' "$LOG" | tail -1)
echo "visite https : [$H]"
echo "visite http  : [$P]"
echo "--- synthèse (pair, XFP) sur tout le trafic du journal ---"
awk -F'\t' '{c[$2" XFP="$3]++} END{for(k in c) print c[k], k}' "$LOG" | sort -rn
[ -n "$H" ] && [ -n "$P" ] || { echo "STOP: une visite est absente du journal (mauvais RID ?)"; exit 1; }
[ "$H" = "$PROXY_IP https" ] || { echo "VERDICT: CORRECTIF B INVALIDE. La visite https n'arrive pas avec 'pair=$PROXY_IP, XFP=https'. Appliquer B provoquerait une BOUCLE. Ne pas passer à la phase 2."; exit 1; }
case "$P" in
  "$PROXY_IP -"|"$PROXY_IP http") echo "VERDICT: PREMISSE CONFIRMEE. https = (proxy, https) ; http = (proxy, pas https). Phase 2 possible." ;;
  *) echo "VERDICT: CORRECTIF B INUTILE ou prémisse fausse. La visite http arrive avec [$P] : il faudrait (proxy, absent|http). Ne pas passer à la phase 2."; exit 1 ;;
esac
EOS
```

Valeurs attendues (`-` = en-tête absent) :

| visite | pair (`$realip_remote_addr`) | XFP journalisé | lecture |
|---|---|---|---|
| `https://cazalia.fr/?obs=https-…` | `10.1.20.100` | `https` | normal |
| `http://cazalia.fr/?obs=http-…` | `10.1.20.100` | `-` (ou `http`) | **prémisse confirmée** |

**Ce qui invalide le correctif B** (le script s'arrête avec `VERDICT: …`) :

- la visite **https** n'arrive pas avec XFP **exactement** `https` (absent, `http`, ou
  `https, https` si un en-tête est doublé) : la condition redirigerait ce trafic
  vers https, **boucle** ;
- le pair n'est pas `10.1.20.100` (par exemple `127.0.0.1` : NPM serait en
  conteneur et le CT 120 verrait une autre adresse) : la condition ne se
  déclencherait jamais ;
- la visite **http** arrive avec `https` : l'en-tête est injecté sur le chemin 80,
  la condition ne se déclencherait jamais.

Dans la synthèse, toute valeur d'XFP autre que `https` ou `-` venant du proxy
mérite une explication avant la phase 2.

## 1.5 Côté NPM (CT 100) : où `X-Forwarded-Proto` est posé

Sur le CT 100, lecture seule :

```bash
grep -rn 'X-Forwarded-Proto' /data/nginx/custom/ /data/nginx/proxy_host/ /etc/nginx/conf.d/include/proxy.conf
```

Si NPM tourne en conteneur, préfixer par `docker exec <conteneur>` (les chemins sont ceux
du conteneur). Une erreur `No such file or directory` n'est **pas** « aucun résultat » :
c'est un chemin à corriger, ne pas conclure. À lire :

- la ligne du bloc 443 (`/data/nginx/custom/http.conf`) qui fait arriver `https` ;
- pourquoi le chemin 80 n'en pose pas (ou pose autre chose) ;
- **si la valeur `https` vient d'un fichier hors `/data`** (typiquement
  `/etc/nginx/conf.d/include/proxy.conf`, dans l'image) : une mise à jour de NPM peut
  le régénérer et retirer l'en-tête, donc déclencher la boucle. Les fichiers
  `custom` sous `/data` survivent aux mises à jour. Le noter dans
  `Infra local/Reverse-proxy-et-SSL.md`.

## 1.6 Fin de phase 1

Le journal peut rester actif jusqu'à la phase 2 (il grossit lentement). Pour tout retirer,
utiliser la commande de retour arrière de 1.2, puis `rm -f /var/log/nginx/cazalia-observe.log`.
**Si le verdict n'est pas « PREMISSE CONFIRMEE » : arrêter ici, remonter les valeurs observées.**

---

# PHASE 2 : appliquer (seulement si la phase 1 est confirmée)

## 2.0 Avant de commencer

- Phase 1 conclue par `VERDICT: PREMISSE CONFIRMEE`.
- **Webhook Stripe** : dans le tableau de bord Stripe (Développeurs, Webhooks), l'URL
  du point de terminaison commence par `https://`.
- **Webhook Brevo** : l'URL est construite en `server/src/routes/emails.js:132`
  (`<PUBLIC_BASE_URL ou https://cazalia.fr>/api/webhooks/brevo/<jeton>`) et **saisie à la main
  dans la console Brevo**. Dans la console Brevo (webhooks transactionnels), vérifier à l'œil
  que l'URL commence par `https://cazalia.fr/api/webhooks/brevo/` ; **ne pas copier le jeton**.
  La route répondant `204` même quand rien n'est appliqué, une URL fausse ne produit aucune
  erreur visible : seuls les événements de délivrabilité manquent. Côté CT 120, vérifier que
  `PUBLIC_BASE_URL` n'est pas en `http://` (n'afficher que cette clé, jamais tout le fichier) :
  `systemctl cat lucie-cowork.service | grep -E 'EnvironmentFile|WorkingDirectory'`, puis
  `grep -E '^PUBLIC_BASE_URL=' <fichier d'environnement>`.
  **Ne pas cliquer « déclarer le webhook » dans l'application pour tester : cela fait
  tourner le jeton** (`rotateBrevoWebhookToken`).
- Avec cette conception, `/api/` n'est pas redirigé : ces deux webhooks ne casseraient pas
  même en `http://`. Le contrôle reste utile (le jeton Brevo circulerait en clair, et toute
  extension future de la redirection à `/api/` les casserait en silence).

## 2.1 Contrôles, sauvegarde unique, script de retour arrière

```bash
bash <<'EOS'
set -u
EXPECTED_PROXY=10.1.20.100
DOMAIN=cazalia.fr
ENVF=/root/cazalia-tls.env
CONF=/etc/nginx/conf.d/cazalia-force-https.conf
command -v nginx >/dev/null || { echo "STOP: nginx absent du PATH"; exit 1; }
FOUND=$(grep -RlE 'cazalia_proto' /etc/nginx/sites-enabled /etc/nginx/conf.d | xargs -r -n1 readlink -f | sort -u)
[ -n "$FOUND" ] || { echo "STOP: aucun vhost ne contient cazalia_proto"; exit 1; }
[ "$(printf '%s\n' "$FOUND" | wc -l)" -eq 1 ] || { echo "STOP: plusieurs vhosts candidats:"; echo "$FOUND"; exit 1; }
VHOST=$FOUND
[ -f "$VHOST" ] || { echo "STOP: $VHOST n'est pas un fichier"; exit 1; }
PROXY_IP=$(grep -oP '^\s*set_real_ip_from\s+\K[0-9.]+(?=\s*;)' "$VHOST" | sort -u)
[ "$PROXY_IP" = "$EXPECTED_PROXY" ] || { echo "STOP: set_real_ip_from lu = [$PROXY_IP], attendu [$EXPECTED_PROXY]"; exit 1; }
grep -qE '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf;' /etc/nginx/nginx.conf || { echo "STOP: conf.d/*.conf non inclus"; exit 1; }
grep -qE "server_name([^;]*[[:space:]])?${DOMAIN//./\\.}([[:space:]]|;)" "$VHOST" || { echo "STOP: server_name de $VHOST ne contient pas $DOMAIN"; exit 1; }
# Garde anti-double-application
[ -e "$CONF" ] && { echo "STOP: $CONF existe déjà : déjà appliqué (ou intervention interrompue). Faire le retour arrière avant de relancer."; exit 1; }
grep -q 'absolute_redirect off' "$VHOST" && { echo "STOP: déjà appliqué (absolute_redirect off présent). Faire le retour arrière avant de relancer."; exit 1; }
HITS=$(grep -Rl 'cazalia_force_https\|cazalia_xfp_not_https\|cazalia_from_proxy\|cazalia_redirect_host' /etc/nginx || true)
[ -z "$HITS" ] || { echo "STOP: variables déjà définies dans:"; echo "$HITS"; exit 1; }
# Points d'ancrage : exactement un chacun
[ "$(grep -c 'server_tokens off;' "$VHOST")" -eq 1 ] || { echo "STOP: 'server_tokens off;' doit apparaître exactement 1 fois dans $VHOST"; exit 1; }
[ "$(grep -cE '^[[:space:]]*location / \{' "$VHOST")" -eq 1 ] || { echo "STOP: 'location / {' doit apparaître exactement 1 fois dans $VHOST"; exit 1; }
nginx -t || { echo "STOP: configuration actuelle déjà invalide"; exit 1; }
# Sauvegarde au nom unique (date + PID), jamais réutilisé. Pas de -a : on ne
# préserve pas la date de modification, qui fausserait tout tri chronologique.
STAMP=$(date +%Y%m%d-%H%M%S)-$$
BACKUP="$VHOST.avant-tls-$STAMP"
RB="/root/cazalia-rollback-$STAMP.sh"
[ ! -e "$BACKUP" ] && [ ! -e "$RB" ] || { echo "STOP: nom de sauvegarde déjà pris"; exit 1; }
cp --preserve=mode,ownership "$VHOST" "$BACKUP" || { echo "STOP: copie de sauvegarde échouée"; exit 1; }
cmp -s "$VHOST" "$BACKUP" || { echo "STOP: sauvegarde différente de l'original"; exit 1; }
# Script de retour arrière avec les valeurs EN DUR
{
  echo '#!/bin/bash'
  echo 'set -u'
  printf 'cp --preserve=mode,ownership %q %q || { echo "STOP: restauration échouée"; exit 1; }\n' "$BACKUP" "$VHOST"
  printf 'rm -f %q\n' "$CONF"
  echo 'nginx -t || { echo "STOP: nginx -t KO après retour arrière"; exit 1; }'
  echo 'systemctl reload nginx && echo retour-arriere-ok'
} > "$RB"
chmod 700 "$RB"
( umask 077; printf 'VHOST=%q\nPROXY_IP=%q\nBACKUP=%q\nRB=%q\n' "$VHOST" "$PROXY_IP" "$BACKUP" "$RB" > "$ENVF" )
echo "OK  SAUVEGARDE : $BACKUP"
echo "OK  RETOUR ARRIERE : bash $RB"
echo "NOTER ces deux lignes avant de continuer."
EOS
```

## 2.2 Application (une seule fois), test, rechargement

Le bloc applique sur une **copie** du vhost, vérifie, installe, puis `nginx -t` et
`reload`. **Si `nginx -t` ou le reload échoue, il lance lui-même le retour arrière.**

```bash
bash <<'EOS'
set -u
DOMAIN=cazalia.fr
ENVF=/root/cazalia-tls.env
CONF=/etc/nginx/conf.d/cazalia-force-https.conf
[ -r "$ENVF" ] || { echo "STOP: $ENVF absent, rejouer 2.1"; exit 1; }
. "$ENVF"
[ -n "${BACKUP:-}" ] && [ -f "$BACKUP" ] || { echo "STOP: sauvegarde introuvable, rejouer 2.1"; exit 1; }
[ -x "${RB:-}" ] || { echo "STOP: script de retour arrière introuvable, rejouer 2.1"; exit 1; }
rollback() { echo "!!! RETOUR ARRIERE AUTOMATIQUE"; bash "$RB"; }
[ -e "$CONF" ] && { echo "STOP: $CONF existe déjà : déjà appliqué"; exit 1; }
grep -q 'absolute_redirect off' "$VHOST" && { echo "STOP: déjà appliqué"; exit 1; }
cmp -s "$VHOST" "$BACKUP" || { echo "STOP: le vhost a changé depuis la sauvegarde 2.1"; exit 1; }
[ "$(grep -c 'server_tokens off;' "$VHOST")" -eq 1 ] || { echo "STOP: ancrage server_tokens"; exit 1; }
[ "$(grep -cE '^[[:space:]]*location / \{' "$VHOST")" -eq 1 ] || { echo "STOP: ancrage location /"; exit 1; }

# 1) Variables (contexte http) : fichier conf.d
cat > "$CONF" <<'EOF'
# Redirection http -> https des visiteurs publics (voir deploy/nginx.conf pour le détail).
# Redirige si : pair TCP = reverse proxy ET il ne déclare pas X-Forwarded-Proto: https.
# ATTENTION : échoue FERMÉ. Si le proxy cesse de poser "https" sur le chemin 443 -> boucle.
map $http_x_forwarded_proto $cazalia_xfp_not_https {
    https   0;
    default 1;
}
map $realip_remote_addr $cazalia_from_proxy {
    default                0;
    PROXY_IP_A_RENSEIGNER  1;
}
map "$cazalia_from_proxy$cazalia_xfp_not_https" $cazalia_force_https {
    default 0;
    "11"    1;
}
map $host $cazalia_redirect_host {
    default                    DOMAINE_A_RENSEIGNER;
    DOMAINE_A_RENSEIGNER       DOMAINE_A_RENSEIGNER;
    www.DOMAINE_A_RENSEIGNER   www.DOMAINE_A_RENSEIGNER;
}
EOF
sed -i -e "s/PROXY_IP_A_RENSEIGNER/$PROXY_IP/g" -e "s/DOMAINE_A_RENSEIGNER/$DOMAIN/g" "$CONF"
if grep -q RENSEIGNER "$CONF"; then echo "STOP: marqueur non remplacé dans $CONF"; rollback; exit 1; fi

# 2) Vhost : travail sur une copie
TMP=$(mktemp /root/cazalia-vhost.XXXXXX)
SNA=$(mktemp /root/cazalia-snipA.XXXXXX)
SNB=$(mktemp /root/cazalia-snipB.XXXXXX)
trap 'rm -f "$TMP" "$SNA" "$SNB"' EXIT
cat > "$SNA" <<'EOF'

    # Correctif A : redirection de répertoire en URL relative (garde le schéma https).
    absolute_redirect off;
EOF
cat > "$SNB" <<'EOF'
        # Correctif B : http public (relayé par le proxy) -> https. LAN direct épargné.
        # 302 (pas 301) : pas de cache navigateur en cas de boucle. Passer en 301
        # après quelques semaines sans incident (voir runbook).
        # Dans `location /` : /api/ n'est volontairement pas redirigé (POST webhooks).
        if ($cazalia_force_https) {
            return 302 https://$cazalia_redirect_host$request_uri;
        }

EOF
cp "$VHOST" "$TMP"
sed -i "/^[[:space:]]*server_tokens off;/r $SNA" "$TMP"
sed -i "/^[[:space:]]*location \/ {/r $SNB" "$TMP"
[ "$(grep -c 'absolute_redirect off;' "$TMP")" -eq 1 ] || { echo "STOP: insertion A inattendue"; rollback; exit 1; }
[ "$(grep -cF 'return 302 https://$cazalia_redirect_host$request_uri;' "$TMP")" -eq 1 ] || { echo "STOP: insertion B inattendue"; rollback; exit 1; }
[ "$(diff "$BACKUP" "$TMP" | grep -c '^<')" -eq 0 ] || { echo "STOP: l'édition retirerait des lignes"; rollback; exit 1; }
diff "$BACKUP" "$TMP"

# 3) Installation, test, reload
cat "$TMP" > "$VHOST"
nginx -t || { echo "STOP: nginx -t KO"; rollback; exit 1; }
systemctl reload nginx || { echo "STOP: reload KO"; rollback; exit 1; }
echo "OK appliqué. Enchaîner IMMÉDIATEMENT sur la section 5 (depuis un poste)."
EOS
```

Attendu : un `diff` qui n'affiche que des lignes `>` (ajoutées), puis `OK appliqué`.
Une relance du bloc après un échec ou une interruption s'arrête sur `déjà appliqué` :
faire d'abord le retour arrière (section 6), puis rejouer 2.1.

## 5. Vérification (depuis un poste, pas depuis le CT)

**5.0** Le site tourne-t-il toujours ? (10 secondes)

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cazalia.fr/
```

Attendu : `200`. **Autre chose (301, 302, 5xx, timeout) : retour arrière immédiat (section 6).**

**5.1 Pas de boucle de redirection** (le risque principal du correctif B) :

```bash
curl -sSL --max-redirs 5 -o /dev/null -w '%{http_code} redirections=%{num_redirects} %{url_effective}\n' http://cazalia.fr/
curl -sSL --max-redirs 5 -o /dev/null -w '%{http_code} redirections=%{num_redirects} %{url_effective}\n' https://cazalia.fr/
```

Attendu : `200 redirections=1 https://cazalia.fr/` puis `200 redirections=0 https://cazalia.fr/`.
`curl: (47) Maximum redirects followed` = boucle : retour arrière.

**5.2 Problème A réglé** (`/tarifs` ne quitte plus https) :

```bash
curl -sSI https://cazalia.fr/tarifs | grep -iE '^(HTTP|location)'
curl -sSL -o /dev/null -w '%{http_code} %{url_effective}\n' https://cazalia.fr/tarifs
```

Attendu : `HTTP/2 301` et `location: /tarifs/` (relatif), puis `200 https://cazalia.fr/tarifs/`.

**5.3 Problème B réglé** (le clair est redirigé en 302, chemin et paramètres conservés ;
`/api/` n'est volontairement pas redirigé) :

```bash
for p in / /login '/tarifs/?a=1&b=2'; do
  printf '%-20s ' "$p"; curl -sSI "http://cazalia.fr$p" | tr -d '\r' | awk 'NR==1{printf "%s ",$0} tolower($1)=="location:"{print $2}'
done
printf '%-20s ' '/api/config'; curl -sS -o /dev/null -w '%{http_code}\n' http://cazalia.fr/api/config
```

Attendu : trois lignes `HTTP/1.1 302 Moved Temporarily https://cazalia.fr<chemin>` (avec la chaîne
de requête intacte), et `/api/config` en `200` (non redirigé, par conception).

**5.4 Un POST sur `/api/` n'est pas redirigé** (webhooks Stripe et Brevo ; requête sans
signature, rejetée par l'application, elle ne crée rien) :

```bash
curl -sS -o /dev/null -w 'POST http stripe: %{http_code}\n' -X POST -H 'Content-Type: application/json' --data-binary '{}' http://cazalia.fr/api/webhooks/stripe
curl -sS -o /dev/null -w 'POST https stripe: %{http_code}\n' -X POST -H 'Content-Type: application/json' --data-binary '{}' https://cazalia.fr/api/webhooks/stripe
```

Attendu : deux codes **identiques et différents de 301/302/307/308** (typiquement `400`, signature
absente). Un `302` ici = la redirection a atteint `/api/` : retour arrière.

**5.5 Accès LAN direct intact** (depuis un poste du LAN `10.1.20.0/24`) :

```bash
curl -sS -o /dev/null -w 'LAN /                 %{http_code}\n' http://10.1.20.120/
curl -sS -o /dev/null -w 'LAN /api/config       %{http_code}\n' http://10.1.20.120/api/config
curl -sSI http://10.1.20.120/tarifs | grep -iE '^(HTTP|location)'
curl -sS -o /dev/null -w 'LAN sans en-tete      %{http_code}\n' http://10.1.20.120/
curl -sS -o /dev/null -w 'LAN en-tete forge     %{http_code}\n' -H 'X-Forwarded-Proto: http' http://10.1.20.120/
```

Attendu : `200`, `200`, `301` avec `Location: /tarifs/`, `200`, `200` (en-tête forgé ignoré : le pair
n'est pas NPM). Aucune ligne ne doit renvoyer `302`.

**5.6 En-têtes de sécurité émis une seule fois** (nginx ou l'application, pas les deux) :

```bash
for p in / /tarifs/ /api/config; do
  echo "== $p"
  curl -sSI "https://cazalia.fr$p" | tr -d '\r' | awk -F: 'tolower($1)~/^(strict-transport-security|x-frame-options|x-content-type-options|content-security-policy|referrer-policy|permissions-policy|cross-origin-opener-policy)$/{c[tolower($1)]++} END{for(k in c)print c[k], k}' | sort -k2
done
```

Attendu : chaque ligne commence par `1`, **sauf** `strict-transport-security` sur
`/api/config` qui vaut `2`. Ce doublon HSTS est **antérieur** à ces correctifs
(NPM émet `max-age=63072000`, l'application `max-age=31536000; includeSubDomains`) ;
inoffensif, à nettoyer à part. Tout autre compteur à `2` = régression : retour arrière.

**5.7 Cookie de session toujours `Secure`** (compte de test dédié, pas un compte admin).
Le mot de passe est lu sans écho, **n'apparaît jamais dans la ligne de commande de
`curl`** (visible dans `ps` et `/proc/<pid>/cmdline`) : le corps JSON arrive par l'entrée
standard (`--data-binary @-`). Le JSON est fabriqué par `jq` à partir de variables
d'**environnement** (`env.T_MAIL`, `env.T_PASS`) : `jq --arg` mettrait le mot de passe
dans la ligne de commande de `jq`, et un mot de passe contenant `"` ou `\` casserait
un JSON écrit à la main (un `400` qu'on lirait à tort comme un échec du correctif).

```bash
read -r -p 'e-mail de test: ' T_MAIL; read -r -s -p 'mot de passe: ' T_PASS; echo
export T_MAIL T_PASS
jq -n '{email: env.T_MAIL, password: env.T_PASS}' \
  | curl -sSi -X POST https://cazalia.fr/api/auth/login -H 'Content-Type: application/json' --data-binary @- \
  | tr -d '\r' | grep -iE '^(HTTP|set-cookie)'
unset T_MAIL T_PASS
```

Sans `jq` : remplacer la 2e ligne par
`python3 -c 'import json,os;print(json.dumps({"email":os.environ["T_MAIL"],"password":os.environ["T_PASS"]}))' \`.

Attendu : `HTTP/2 200` et une ligne `set-cookie:` contenant `; Secure` (avec `HttpOnly`).
Pas de `Secure` : retour arrière. Un `401` = mauvais identifiants de test, pas le correctif.
(Limite d'authentification : 1 requête/s, ne pas répéter en rafale.)

**5.8 Journaux sans erreur** (dans le CT 120) :

```bash
tail -n 20 /var/log/nginx/error.log
```

Attendu : aucune ligne `emerg`, `crit` ni `rewrite or internal redirection cycle`.

Critère de réussite : 5.0 à 5.8 conformes. Noter l'intervention dans le journal de
`Infra local/README.md` (§10) et `Infra local/Reverse-proxy-et-SSL.md` (§12), avec la
valeur de `SAUVEGARDE` et les observations de la phase 1.

---

## 6. Retour arrière

Le plus simple : le script généré en 2.1, qui contient les chemins **en dur**
(sauvegarde unique, pas de tri par date) :

```bash
bash /root/cazalia-rollback-<STAMP>.sh
```

(`<STAMP>` : la valeur affichée à la fin de 2.1 ; à défaut, `ls /root/cazalia-rollback-*.sh`
et prendre celui dont le contenu cite la bonne sauvegarde : `cat` avant d'exécuter.)

Équivalent manuel, avec les valeurs affichées en 2.1 écrites en dur (ne pas utiliser
`ls -t … | head -1` : à la deuxième intervention il restaurerait un état déjà corrigé) :

```bash
bash <<'EOS'
set -u
cp --preserve=mode,ownership '<SAUVEGARDE affichée en 2.1>' '<VHOST affiché en 1.1>' || { echo "STOP: restauration échouée"; exit 1; }
rm -f /etc/nginx/conf.d/cazalia-force-https.conf
nginx -t || { echo "STOP: nginx -t KO"; exit 1; }
systemctl reload nginx && echo retour-arriere-ok
EOS
```

Puis, depuis un poste : `curl -sS -o /dev/null -w '%{http_code}\n' https://cazalia.fr/` attendu `200`.

Effet : le vhost est identique à celui d'avant (octet pour octet, `cmp` fait en 2.1),
le fichier `conf.d` est supprimé. `/tarifs` en https renvoie de nouveau un 301 vers `http://`
et le port 80 public répond de nouveau en clair. La redirection étant en **302**, aucun
navigateur n'en garde de trace. Rien à toucher côté NPM, rien à redémarrer.

Si le CT 120 lui-même ne répond plus : console Proxmox, `pct enter 120`, même commande.

## Passage ultérieur en 301

Après plusieurs semaines sans incident (et sans mise à jour de NPM non vérifiée), la
redirection peut passer en 301 (cachée par les navigateurs, meilleure pour le SEO). Une
seule ligne, dans `location /` du vhost :
`return 302 https://$cazalia_redirect_host$request_uri;` devient `return 301 …`. Faire une
sauvegarde au nom unique, `nginx -t`, `reload`, puis rejouer 5.1. Changer cette ligne rend
le retour arrière **non rattrapable** pour les navigateurs qui auront mémorisé le 301 : c'est
la raison du 302 initial.

## Surveillance (à rejouer après toute intervention sur NPM)

Toute mise à jour de NPM, modification de `/data/nginx/custom/http.conf`, ou édition du
Proxy Host de `cazalia.fr` peut retirer `X-Forwarded-Proto: https` du chemin 443 et
déclencher la boucle. Après chacune, depuis un poste :

```bash
curl -sSL --max-redirs 3 -o /dev/null -w '%{http_code} redirections=%{num_redirects}\n' https://cazalia.fr/
```

Attendu : `200 redirections=0`. Tout autre résultat : retour arrière du correctif B (section 6)
puis diagnostic (phase 1.3 et 1.4).

## Annexe : si la phase 2 ne redirige pas (5.3)

Si 5.1 et 5.2 passent mais que `http://cazalia.fr/…` répond toujours 200, la prémisse de la
phase 1 n'est plus vraie. Ne pas élargir la condition : rejouer 1.2 à 1.4 (journal nginx,
**pas de capture réseau**) et remonter les valeurs observées à l'infra.
