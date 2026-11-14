#!/bin/sh
set -e

# Root degilsek (ornegin platform bu betigi bir kez daha zincirlediyse)
# sahiplik duzeltmeye ve kullanici degistirmeye gerek yok: dogrudan calistir.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# Railway diski root'a ait olarak baglanir; uygulama root DEGIL calisiyor.
# Sahiplik duzeltilmezse SQLite ilk yazmada EACCES alir ve sunucu, veritabani
# yokmus gibi degil, ANLASILMAZ bir hatayla oler.
if [ -n "$BIDE_DB" ]; then
  dir=$(dirname "$BIDE_DB")
  mkdir -p "$dir"
  chown -R bide:bide "$dir" 2>/dev/null || true
fi

# `exec` SART. Olmazsa bu shell 1 numarali surec olarak kalir, SIGTERM ona
# gider ve Node hic duymaz — temiz kapanis calismaz, platform 30 saniye
# sonra zorla oldurur.
exec su-exec bide "$@"
