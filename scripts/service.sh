#!/bin/bash
# Timebot macOS service manager
# Usage: ./scripts/service.sh [install|uninstall|start|stop|restart|status|logs]

set -e

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$0")"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
LABEL="com.$(whoami).timebot"
PLIST_TEMPLATE="$PROJECT_DIR/timebot.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN_PATH="$(which bun 2>/dev/null || echo "")"

case "${1:-}" in
  install)
    if [ -z "$BUN_PATH" ]; then
      echo "Erreur: bun introuvable dans le PATH."
      exit 1
    fi

    echo "Installation du service Timebot..."
    echo "  label:   $LABEL"
    echo "  bun:     $BUN_PATH"
    echo "  projet:  $PROJECT_DIR"

    # Generate plist with actual paths
    sed -e "s|__LABEL__|$LABEL|g" \
        -e "s|__BUN_PATH__|$BUN_PATH|g" \
        -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
        "$PLIST_TEMPLATE" > "$PLIST_DST"

    launchctl load "$PLIST_DST"
    echo "Service installe et demarre."
    echo "  Logs: tail -f $PROJECT_DIR/timebot.log"
    ;;

  uninstall)
    echo "Desinstallation du service Timebot..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "Service supprime."
    ;;

  start)
    launchctl load "$PLIST_DST"
    echo "Timebot demarre."
    ;;

  stop)
    launchctl unload "$PLIST_DST"
    echo "Timebot arrete."
    ;;

  restart)
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    sleep 1
    launchctl load "$PLIST_DST"
    echo "Timebot redemarre."
    ;;

  status)
    INFO=$(launchctl list "$LABEL" 2>&1) || {
      echo "Timebot: non installe."
      exit 0
    }
    PID=$(echo "$INFO" | grep '"PID"' | awk '{print $3}' | tr -d ';')
    if [ -n "$PID" ]; then
      echo "Timebot: en cours (PID $PID)"
    else
      EXIT=$(echo "$INFO" | grep '"LastExitStatus"' | awk '{print $3}' | tr -d ';')
      echo "Timebot: arrete (dernier exit: ${EXIT:-?})"
    fi
    ;;

  logs)
    tail -f "$PROJECT_DIR/timebot.log"
    ;;

  link)
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
    ln -sf "$PROJECT_DIR/scripts/service.sh" "$LINK_DIR/timebot"
    echo "Lien cree: $LINK_DIR/timebot -> $PROJECT_DIR/scripts/service.sh"
    if ! echo "$PATH" | grep -q "$LINK_DIR"; then
      echo ""
      echo "Ajoute ceci a ton ~/.zshrc si ce n'est pas deja fait:"
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
    ;;

  help|--help|-h|*)
    echo "Timebot — gestionnaire de service"
    echo ""
    echo "Usage: timebot <commande>"
    echo ""
    echo "Commandes:"
    echo "  install     Installe et lance le service au demarrage"
    echo "  uninstall   Supprime le service"
    echo "  start       Demarre le service"
    echo "  stop        Arrete le service"
    echo "  restart     Redemarre le service"
    echo "  status      Affiche l'etat du service"
    echo "  logs        Suit les logs en direct (Ctrl+C pour quitter)"
    echo "  link        Cree le lien timebot dans ~/.local/bin"
    [ "${1:-}" != "help" ] && [ "${1:-}" != "--help" ] && [ "${1:-}" != "-h" ] && [ -n "${1:-}" ] && exit 1
    ;;
esac
