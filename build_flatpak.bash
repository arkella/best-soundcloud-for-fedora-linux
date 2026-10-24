#!/usr/bin/env bash
set -e

APP_ID="com.soundcloud.Client"
RUNTIME_VER="24.08"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================================"
echo " 📦 Сборка единого пакета $APP_ID.flatpak"
echo "======================================================"

# 1. Автоопределение папки с исходниками (поддержка подпапки app/ и корня)
SOURCE_APP_DIR=""
if [ -d "$SCRIPT_DIR/app" ] && [ -f "$SCRIPT_DIR/app/main.js" ]; then
  SOURCE_APP_DIR="$SCRIPT_DIR/app"
  echo "✓ Найдены исходники приложения в подпапке: $SOURCE_APP_DIR"
elif [ -f "$SCRIPT_DIR/main.js" ]; then
  SOURCE_APP_DIR="$SCRIPT_DIR"
  echo "✓ Найдены исходники приложения в текущей папке: $SOURCE_APP_DIR"
else
  echo "❌ Ошибка: не найден файл main.js ни в $SCRIPT_DIR/app/, ни в $SCRIPT_DIR/."
  exit 1
fi

# 2. Проверка наличия flatpak и flatpak-builder
for cmd in flatpak flatpak-builder; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "⚙️ Устанавливаем $cmd..."
    if command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y flatpak flatpak-builder
    elif command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y flatpak flatpak-builder
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -S --needed --noconfirm flatpak flatpak-builder
    else
      echo "❌ Ошибка: установите пакеты 'flatpak' и 'flatpak-builder' через ваш пакетный менеджер."
      exit 1
    fi
  fi
done

# 3. Подготовка временного рабочего каталога .flatpak-staging
STAGE_DIR="$SCRIPT_DIR/.flatpak-staging"
WORK_APP_DIR="$STAGE_DIR/work-app"
rm -rf "$STAGE_DIR"
mkdir -p "$WORK_APP_DIR"

# Копируем исходники из SOURCE_APP_DIR во временную папку сборки
for item in "$SOURCE_APP_DIR/"*; do
  base_item="$(basename "$item")"
  if [ "$base_item" != "node_modules" ] && [ "$base_item" != ".flatpak-staging" ] && [ "$base_item" != ".flatpak-build" ] && [ "$base_item" != ".flatpak-repo" ]; then
    cp -a "$item" "$WORK_APP_DIR/"
  fi
done

if [ ! -f "$WORK_APP_DIR/package.json" ]; then
  cat << 'EOF' > "$WORK_APP_DIR/package.json"
{
  "name": "soundcloud-electron",
  "version": "1.0.0",
  "description": "SoundCloud Desktop Client with Studio Bass Boost, 10-Band EQ & Custom Wallpapers",
  "main": "main.js",
  "author": "SoundCloud Electron",
  "license": "MIT",
  "dependencies": {
    "auto-launch": "^5.0.6",
    "axios": "^1.7.9",
    "cheerio": "^1.0.0",
    "discord-rpc": "^4.0.0",
    "electron-store": "^8.2.0"
  },
  "devDependencies": {
    "electron": "^33.3.0"
  }
}
EOF
fi

# 4. Поиск уже скачанных node_modules (включая текущую папку, app/ или ~/.local/share)
for CANDIDATE in \
  "$SCRIPT_DIR" \
  "$SOURCE_APP_DIR" \
  "$HOME/.local/share/$APP_ID" \
  "$HOME/soundcloud-electron" \
  "$HOME/Загрузки/soundcloud-electron" \
  "$HOME/Downloads/soundcloud-electron"; do
  if [ -d "$CANDIDATE/node_modules/electron/dist" ]; then
    echo "✓ Используем уже установленный рантайм Electron из: $CANDIDATE/node_modules"
    cp -a "$CANDIDATE/node_modules" "$WORK_APP_DIR/"
    break
  fi
done

if [ ! -d "$WORK_APP_DIR/node_modules/electron/dist" ]; then
  echo "📥 Установка зависимостей npm и бинарного рантайма Electron..."
  (cd "$WORK_APP_DIR" && npm install --no-audit --no-fund)
fi

# 5. Извлекаем встроенные файлы (index.html, styles.css, preload.js, mpris_bridge.py, иконки) из main.js
echo "🔄 Синхронизация ресурсов и иконок приложения из main.js..."
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const mainPath = path.join(dir, "main.js");
  const mainCode = fs.readFileSync(mainPath, "utf8");

  const mFiles = mainCode.match(/const EMBEDDED_FILES\s*=\s*(\{[\s\S]*?\});\s*const EMBEDDED_ICONS_B64/);
  if (mFiles) {
    const files = eval("(" + mFiles[1] + ")");
    for (const [rel, content] of Object.entries(files)) {
      if (rel === "preload-view.js" && fs.existsSync(path.join(dir, "preload-view.js"))) continue;
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      if (rel.endsWith(".py")) fs.chmodSync(p, 0o755);
    }
  }

  const mIcons = mainCode.match(/const EMBEDDED_ICONS_B64\s*=\s*(\{[\s\S]*?\});/);
  if (mIcons) {
    const icons = eval("(" + mIcons[1] + ")");
    for (const [rel, b64] of Object.entries(icons)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(b64, "base64"));
    }
  }
' "$WORK_APP_DIR"

# Гарантируем наличие иконки в assets/icon.png
mkdir -p "$WORK_APP_DIR/assets"
if [ ! -f "$WORK_APP_DIR/assets/icon.png" ] && [ -f "$WORK_APP_DIR/icon.png" ]; then
  cp -a "$WORK_APP_DIR/icon.png" "$WORK_APP_DIR/assets/icon.png"
fi

# 6. Установка Flatpak-рантайма и BaseApp для Electron (если ещё не установлены)
echo "🌐 Проверка репозитория Flathub и рантаймов..."
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y --noninteractive flathub \
  "org.freedesktop.Platform//${RUNTIME_VER}" \
  "org.freedesktop.Sdk//${RUNTIME_VER}" \
  "org.electronjs.Electron2.BaseApp//${RUNTIME_VER}"

# 7. Формируем автономный каталог electron-app для упаковки в Flatpak
mkdir -p "$STAGE_DIR/electron-app/resources/app"

echo "📂 Упаковка движка Electron и всех модулей..."
cp -a "$WORK_APP_DIR/node_modules/electron/dist/"* "$STAGE_DIR/electron-app/"

for f in package.json main.js preload.js preload-view.js index.html styles.css mpris_bridge.py icon.png; do
  if [ -f "$WORK_APP_DIR/$f" ]; then
    cp -a "$WORK_APP_DIR/$f" "$STAGE_DIR/electron-app/resources/app/"
  fi
done

if [ -d "$WORK_APP_DIR/assets" ]; then
  cp -a "$WORK_APP_DIR/assets" "$STAGE_DIR/electron-app/resources/app/"
  cp -a "$WORK_APP_DIR/assets" "$STAGE_DIR/electron-app/resources/"
fi
if [ -f "$WORK_APP_DIR/mpris_bridge.py" ]; then
  cp -a "$WORK_APP_DIR/mpris_bridge.py" "$STAGE_DIR/electron-app/resources/"
fi

# Копируем runtime-зависимости в resources/app/node_modules (без тяжёлого пакета electron)
mkdir -p "$STAGE_DIR/electron-app/resources/app/node_modules"
for mod in "$WORK_APP_DIR/node_modules/"*; do
  mod_name="$(basename "$mod")"
  if [ "$mod_name" != "electron" ] && [ "$mod_name" != "electron-builder" ] && [ "$mod_name" != ".bin" ]; then
    cp -a "$mod" "$STAGE_DIR/electron-app/resources/app/node_modules/"
  fi
done

# Удаляем временную копию work-app перед запуском flatpak-builder, чтобы не дублировать размер
rm -rf "$WORK_APP_DIR"

# 8. Создаём стартовый скрипт, .desktop файл и метаданные AppStream
cat << 'EOF' > "$STAGE_DIR/run-soundcloud.sh"
#!/usr/bin/env bash
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
if command -v zypak-wrapper >/dev/null 2>&1; then
  exec zypak-wrapper /app/main/electron /app/main/resources/app --ozone-platform-hint=auto "$@"
else
  exec /app/main/electron /app/main/resources/app --no-sandbox --ozone-platform-hint=auto "$@"
fi
EOF
chmod +x "$STAGE_DIR/run-soundcloud.sh"

cat << EOF > "$STAGE_DIR/$APP_ID.desktop"
[Desktop Entry]
Name=SoundCloud
GenericName=Music Player
Comment=SoundCloud Desktop Client with Studio Bass Boost, 10-Band EQ & Custom Wallpapers
Exec=run-soundcloud.sh %U
Terminal=false
Type=Application
Icon=$APP_ID
StartupWMClass=$APP_ID
Categories=AudioVideo;Audio;Player;Music;
Keywords=soundcloud;music;audio;player;
EOF

cat << EOF > "$STAGE_DIR/$APP_ID.metainfo.xml"
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>$APP_ID</id>
  <name>SoundCloud</name>
  <summary>SoundCloud Desktop Client with Studio Bass Boost, 10-Band EQ and Custom Wallpapers</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <launchable type="desktop-id">$APP_ID.desktop</launchable>
  <description>
    <p>Desktop client for SoundCloud featuring real-time WebAudio Studio Bass Boost, 10-band equalizer, custom video/GIF wallpapers, particle effects, Genius lyrics, Discord Rich Presence, and MPRIS2 integration.</p>
  </description>
</component>
EOF

# 9. Создаём манифест Flatpak
MANIFEST_FILE="$STAGE_DIR/$APP_ID.json"
cat << EOF > "$MANIFEST_FILE"
{
  "app-id": "$APP_ID",
  "runtime": "org.freedesktop.Platform",
  "runtime-version": "$RUNTIME_VER",
  "sdk": "org.freedesktop.Sdk",
  "base": "org.electronjs.Electron2.BaseApp",
  "base-version": "$RUNTIME_VER",
  "command": "run-soundcloud.sh",
  "separate-locales": false,
  "finish-args": [
    "--share=ipc",
    "--socket=x11",
    "--socket=wayland",
    "--socket=pulseaudio",
    "--share=network",
    "--device=dri",
    "--talk-name=org.freedesktop.Notifications",
    "--talk-name=org.kde.StatusNotifierWatcher",
    "--own-name=org.mpris.MediaPlayer2.soundcloud",
    "--filesystem=xdg-music:ro",
    "--filesystem=xdg-pictures:ro",
    "--filesystem=xdg-videos:ro",
    "--filesystem=xdg-download:ro",
    "--filesystem=xdg-run/discord-ipc-0",
    "--filesystem=xdg-run/app/com.discordapp.Discord:create",
    "--env=XDG_CURRENT_DESKTOP=GNOME"
  ],
  "modules": [
    {
      "name": "soundcloud-client",
      "buildsystem": "simple",
      "build-commands": [
        "mkdir -p /app/main /app/bin /app/share/applications /app/share/metainfo",
        "cp -a electron-app/* /app/main/",
        "chmod -R a+rX /app/main",
        "install -Dm755 run-soundcloud.sh /app/bin/run-soundcloud.sh",
        "install -Dm644 $APP_ID.desktop /app/share/applications/$APP_ID.desktop",
        "install -Dm644 $APP_ID.metainfo.xml /app/share/metainfo/$APP_ID.metainfo.xml",
        "for sz in 64x64 128x128 256x256 512x512; do install -Dm644 electron-app/resources/app/assets/icon.png /app/share/icons/hicolor/\$sz/apps/$APP_ID.png; done"
      ],
      "sources": [
        {
          "type": "dir",
          "path": "."
        }
      ]
    }
  ]
}
EOF

# 10. Компиляция в локальный репозиторий и экспорт в единый файл .flatpak
BUILD_DIR="$SCRIPT_DIR/.flatpak-build"
REPO_DIR="$SCRIPT_DIR/.flatpak-repo"
OUT_BUNDLE="$SCRIPT_DIR/$APP_ID.flatpak"

echo "🔨 Сборка Flatpak-пакета..."
flatpak-builder --user --force-clean --repo="$REPO_DIR" "$BUILD_DIR" "$MANIFEST_FILE"

echo "📦 Упаковка в единый установочный файл $APP_ID.flatpak..."
flatpak build-bundle "$REPO_DIR" "$OUT_BUNDLE" "$APP_ID"

# 11. Полная очистка всех временных папок и лишних файлов в корне
rm -rf "$STAGE_DIR" "$BUILD_DIR" "$REPO_DIR" "$SCRIPT_DIR/.flatpak-builder"
if [ "$SOURCE_APP_DIR" = "$SCRIPT_DIR/app" ]; then
  rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json"
fi

echo "======================================================"
echo "✅ Готово! Создан единый файл: $OUT_BUNDLE"
echo ""
echo "Теперь программу можно установить:"
echo "  • Двойным кликом по файлу $APP_ID.flatpak (через Центр приложений)"
echo "  • Или одной командой в терминале:"
echo "    flatpak install --user -y $APP_ID.flatpak"
echo "======================================================"