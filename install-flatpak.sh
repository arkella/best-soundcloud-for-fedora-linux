#!/usr/bin/env bash
set -e

APP_ID="com.soundcloud.Client"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================================"
echo " ☁️ Установка пакета SoundCloud ($APP_ID)"
echo "======================================================"

# 1. Полное удаление старого виджета верхней панели GNOME (если был установлен)
EXT_UUID="soundcloud-panel@soundcloud.electron"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions disable "$EXT_UUID" >/dev/null 2>&1 || true
fi
if [ -d "$EXT_DIR" ]; then
  rm -rf "$EXT_DIR"
  echo "✓ Убрана старая панель трека из верхнего бара GNOME."
fi

# 2. Определяем папку с файлами приложения
SOURCE_APP_DIR=""
if [ -d "$SCRIPT_DIR/app" ] && [ -f "$SCRIPT_DIR/app/main.js" ]; then
  SOURCE_APP_DIR="$SCRIPT_DIR/app"
elif [ -f "$SCRIPT_DIR/main.js" ]; then
  SOURCE_APP_DIR="$SCRIPT_DIR"
fi

if [ -z "$SOURCE_APP_DIR" ]; then
  echo "Распаковка архива com.soundcloud.Client-flatpak.tar.gz..."
  if [ -f "$SCRIPT_DIR/com.soundcloud.Client-flatpak.tar.gz" ]; then
    tar -xzf "$SCRIPT_DIR/com.soundcloud.Client-flatpak.tar.gz" -C "$SCRIPT_DIR"
    SOURCE_APP_DIR="$SCRIPT_DIR/com.soundcloud.Client-flatpak/app"
  else
    echo "Ошибка: не найдены файлы приложения рядом со скриптом."
    exit 1
  fi
fi

# 3. Устанавливаем зависимости и само приложение в системный каталог пользователя
DEST_DIR="$HOME/.local/share/$APP_ID"
mkdir -p "$DEST_DIR"
cp -r "$SOURCE_APP_DIR/"* "$DEST_DIR/"

# Если в старой папке были node_modules и electron — переносим их за долю секунды без скачивания
for OLD_DIR in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$HOME/soundcloud-electron" "$HOME/Загрузки/soundcloud-electron" "$HOME/Downloads/soundcloud-electron"; do
  if [ -d "$OLD_DIR/node_modules" ] && [ ! -d "$DEST_DIR/node_modules" ]; then
    echo "✓ Найден локальный рантайм Electron — копируем за 1 секунду..."
    cp -a "$OLD_DIR/node_modules" "$DEST_DIR/"
    break
  fi
done

if [ ! -d "$DEST_DIR/node_modules" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "Установка модулей..."
    (cd "$DEST_DIR" && npm install --no-audit --no-fund)
  fi
fi

# Запускаем быструю синхронизацию встроенных файлов и официальных иконок SoundCloud
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    const mainCode = fs.readFileSync(path.join(dir, "main.js"), "utf8");
    const mIcons = mainCode.match(/const EMBEDDED_ICONS_B64 = (\{[\s\S]*?\});/);
    if (mIcons) {
      const icons = eval("(" + mIcons[1] + ")");
      for (const [rel, b64] of Object.entries(icons)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(b64, "base64"));
      }
    }
  ' "$DEST_DIR" >/dev/null 2>&1 || true
fi

# 4. Установка оригинальной иконки SoundCloud во все системные размеры
ICON_FILE="$DEST_DIR/assets/icon.png"
if [ ! -f "$ICON_FILE" ]; then
  ICON_FILE="$DEST_DIR/icon.png"
fi

for SZ in 64x64 128x128 256x256 512x512; do
  ICON_TARGET_DIR="$HOME/.local/share/icons/hicolor/$SZ/apps"
  mkdir -p "$ICON_TARGET_DIR"
  cp -f "$ICON_FILE" "$ICON_TARGET_DIR/$APP_ID.png"
  cp -f "$ICON_FILE" "$ICON_TARGET_DIR/soundcloud-electron.png"
done

mkdir -p "$HOME/.local/share/pixmaps"
cp -f "$ICON_FILE" "$HOME/.local/share/pixmaps/$APP_ID.png"
cp -f "$ICON_FILE" "$HOME/.local/share/pixmaps/soundcloud-electron.png"

# 5. Создаём бинарный лаунчер и ярлык приложения (как у Flatpak-приложений)
mkdir -p "$HOME/.local/bin"
LAUNCHER="$HOME/.local/bin/$APP_ID"
cat << 'EOF' > "$LAUNCHER"
#!/usr/bin/env bash
APP_DIR="$HOME/.local/share/com.soundcloud.Client"
if [ -x "$APP_DIR/node_modules/.bin/electron" ]; then
  exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR/main.js" --no-sandbox --ozone-platform-hint=auto "$@"
elif command -v electron >/dev/null 2>&1; then
  exec electron "$APP_DIR/main.js" --no-sandbox --ozone-platform-hint=auto "$@"
else
  exec npx --prefix "$APP_DIR" electron "$APP_DIR/main.js" --no-sandbox --ozone-platform-hint=auto "$@"
fi
EOF
chmod +x "$LAUNCHER"

# Удаляем старый ярлык soundcloud-electron.desktop чтобы не дублировался
rm -f "$HOME/.local/share/applications/soundcloud-electron.desktop"

APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
cat << EOF > "$APPS_DIR/$APP_ID.desktop"
[Desktop Entry]
Name=SoundCloud
GenericName=Music Player
Comment=SoundCloud Desktop Client with Studio Bass Boost, 10-Band EQ & Custom Wallpapers
Exec="$LAUNCHER" %U
Terminal=false
Type=Application
Icon=$ICON_FILE
StartupWMClass=com.soundcloud.Client
Categories=AudioVideo;Audio;Player;Music;
Keywords=soundcloud;music;audio;player;
EOF
chmod +x "$APPS_DIR/$APP_ID.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "======================================================"
echo "✅ SoundCloud ($APP_ID) установлен за пару секунд!"
echo "   • Оригинальная оранжевая иконка SoundCloud применена"
echo "   • Верхний виджет трека в панели GNOME удалён"
echo "   • Баг с пропажей интерфейса при лайке исправлен"
echo "   • Запускайте «SoundCloud» из меню приложений!"
echo "======================================================"
