# STORAGE&MESS Enterprise в Docker

Один образ: сервер и веб-клиент. База, файлы и ключ удостоверяющего центра устройств лежат на томах и переживают обновление образа.

## Быстрый показ: с учебным каталогом AD

Без настоящего домена, всё на одной машине:

```bash
./tools/docker/init-env.sh --demo
docker compose --profile demo up -d --build
```

- **Мессенджер:** http://localhost:8080. Вход — логином и паролем учебного домена.
- **Консоль учебного AD:** http://127.0.0.1:9480. Здесь можно блокировать, отключать и создавать сотрудников и смотреть, как учётки в мессенджере появляются и схлопываются.
- **Пароли учебных сотрудников:**

```bash
docker compose exec demo-ad cat /demo/state/passwords.txt
```

Учебный каталог годится только для показа. В работе он не нужен.

## Работа с настоящим каталогом

1. Создайте `.env`:

   ```bash
   ./tools/docker/init-env.sh
   ```

2. Впишите в `.env` настройки каталога:
   - `ENT_LDAP_URL`: лучше `ldaps://…:636`;
   - `ENT_LDAP_BIND_DN` и `ENT_LDAP_BIND_PASSWORD`: служебная учётка только на чтение;
   - `ENT_LDAP_BASE_DN`;
   - `ENT_LDAP_GROUP_DN`: кому разрешён мессенджер;
   - `ENT_LDAP_ADMIN_GROUP_DN`: администраторы;
   - `ENT_DOMAIN`.

   Если сертификат контроллера домена выдан своим УЦ, положите его в контейнер и укажите в `ENT_LDAP_CA_FILE`.

3. Вход через RADIUS (второй фактор): `ENT_AUTH=radius`, `ENT_RADIUS_HOST`, `ENT_RADIUS_SECRET`.

4. Соберите и запустите:

   ```bash
   docker compose up -d --build
   ```

5. Включите аварийного администратора. Это локальная учётка `avaria` на случай, когда домен недоступен. Пароль показал `init-env.sh`, впишите его хэш:

   ```bash
   ./tools/docker/init-env.sh --set-breakglass '<пароль>'
   docker compose up -d
   ```

## HTTPS

- **За обратным прокси** (nginx, Traefik, HAProxy) — рекомендуется. Проксируйте на `http://<хост>:8080` вместе с WebSocket (`Upgrade`/`Connection`). В `.env` укажите `SERVER_URL=https://messenger.corp.example`.
- **Прямо в контейнере.** Положите `fullchain.pem` (или `cert.pem`) и `key.pem` в `./certs` и раскомментируйте строку `./certs:/app/server/certs:ro` в `docker-compose.yml`. Сервер сам перейдёт на HTTPS на том же порту.

## Звонки

Встроенный STUN и пересылка медиа идут по UDP, порты публикует `docker-compose.yml`:
- `LOCAL_STUN_PORT`, по умолчанию 3478;
- `LOCAL_RELAY_PORT_MIN`–`LOCAL_RELAY_PORT_MAX`, по умолчанию 50000–50100.

Откройте их на межсетевом экране. В `MEDIASOUP_ANNOUNCED_IP` впишите адрес сервера, который видят клиенты.

## Резервные копии

Важные тома:
- `storage-mess_data` — база и ключ УЦ устройств; без ключа выданные сертификаты устройств придётся перевыпускать;
- `storage-mess_storage` — файлы.

```bash
docker run --rm -v storage-mess_data:/d -v "$PWD":/b debian tar czf /b/data-$(date +%F).tgz -C /d .
docker run --rm -v storage-mess_storage:/d -v "$PWD":/b debian tar czf /b/storage-$(date +%F).tgz -C /d .
```

## Обновление

```bash
git pull
docker compose up -d --build
```

Тома не затрагиваются, схема базы обновляется при старте.

## Что внутри

- **Образ:** `node:22-bookworm-slim`, процесс от пользователя `node`, не root.
- **Проверка живости:** `/api/health` каждые 30 с (`docker compose ps` покажет `healthy`).
- **Поиск серверов в локальной сети:** в контейнере выключен (`LAN_DISCOVERY=0`): широковещание из контейнера всё равно не выходит в сеть.
