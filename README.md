# Timebot

Slack bot pour automatiser les timesheets Tempo. Tourne en daemon sur macOS, envoie des rappels, et permet de logger son temps directement depuis Slack.

> **Vibe coded** avec [Claude Code](https://claude.ai/claude-code) (Claude Opus) -- de l'idee au daemon en conversations naturelles.

## Stack

- **Runtime** : [Bun](https://bun.sh) (TypeScript natif, chargement `.env` integre)
- **Slack** : [@slack/bolt](https://github.com/slackapi/bolt-js) (Socket Mode, pas de serveur HTTP)
- **IA** : [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-js) (Claude Sonnet pour le matching de tickets)
- **APIs** : Tempo v4, Jira REST v3, Folks HR, GitHub
- **Scheduler** : node-cron + detection de reveil macOS

## Fonctionnalites

- Status du jour et de la semaine en un message
- Log du temps via texte libre, ticket direct, ou split multi-tickets
- Claude analyse les descriptions et l'activite GitHub pour suggerer le bon ticket
- Rattrapage automatique des jours non remplis (semaine par semaine)
- Rappel quotidien configurable + resume hebdomadaire le vendredi
- Detection des rappels manques (veille, redemarrage)
- Jours feries dynamiques (FR, QC, ES) + absences via Folks HR
- Tourne en daemon macOS (LaunchAgent) avec auto-restart

---

## Pre-requis

- [Bun](https://bun.sh) >= 1.0
- macOS (pour le daemon LaunchAgent -- le bot peut aussi tourner manuellement sur Linux)
- Comptes : Atlassian (Jira + Tempo), Slack, Anthropic

## Installation

### 1. Cloner et installer

```bash
git clone <repo-url> timebot
cd timebot
bun install
```

### 2. Creer les cles API

Vous aurez besoin de 5 cles (dont 2 optionnelles) :

| Service | Ou la creer | Variable `.env` |
|---------|-------------|-----------------|
| **Jira / Atlassian** | [API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens) | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` |
| **Tempo** | Tempo > Settings > API Integration | `TEMPO_API_TOKEN` |
| **Slack** | [Slack Apps](https://api.slack.com/apps) (voir ci-dessous) | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| **Anthropic** | [Console Anthropic](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| GitHub *(optionnel)* | [Personal Access Tokens](https://github.com/settings/tokens) -- scope `repo` read | `GITHUB_TOKEN` |
| Folks HR *(optionnel)* | Admin > Company > API Key Management | `FOLKS_API_KEY` |

#### Configuration Slack

1. Creer une app sur [api.slack.com/apps](https://api.slack.com/apps)
2. **Socket Mode** : activer dans Settings > Socket Mode, creer un App-Level Token (`xapp-...`) avec le scope `connections:write`
3. **Bot Token Scopes** (OAuth & Permissions) :
   - `chat:write`
   - `im:read`
   - `im:write`
   - `im:history`
   - `commands`
4. **Slash Commands** (Slash Commands > Create New Command) :

   | Commande | Description |
   |----------|-------------|
   | `/timebot` | Status du jour |
   | `/semaine` | Resume de la semaine |
   | `/hier` | Contexte → hier |
   | `/aujourdhui` | Contexte → aujourd'hui |
   | `/rattrapage` | Remplir les jours manquants |
   | `/aide` | Aide |

   Pour chaque commande, mettre l'URL de requete a `https://localhost` (inutilise en Socket Mode).

5. **Event Subscriptions** : activer, ajouter le Bot Event `message.im`
6. **Installer l'app** dans votre workspace

### 3. Configurer

Le setup interactif cree le `.env` et `config.yaml` :

```bash
bun run setup
```

Il teste les connexions Jira, Tempo et Slack pendant la configuration.

Les fichiers generes (`chmod 600`) :

- `.env` -- secrets (tokens, cles API)
- `config.yaml` -- configuration utilisateur (projet, heures, timezone...)

### 4. Lancer

```bash
# Mode dev (auto-reload)
bun run dev

# Mode production
bun start
```

### 5. Installer en daemon (macOS)

```bash
# Installer et lancer le service (demarre automatiquement au login)
./scripts/service.sh install

# Creer la commande `timebot` dans le PATH
./scripts/service.sh link
```

Ensuite :

```bash
timebot status     # Etat du service
timebot restart    # Redemarrer
timebot logs       # Suivre les logs en direct
timebot stop       # Arreter
timebot uninstall  # Supprimer le service
```

Les logs sont dans `timebot.log` a la racine du projet.

---

## Utilisation

### Commandes slash

| Commande | Description |
|----------|-------------|
| `/timebot` | Status du jour + ticket en cours + activite GitHub |
| `/semaine` | Vue de la semaine avec barres de progression |
| `/hier` | Passer le contexte a hier |
| `/aujourdhui` | Revenir au contexte d'aujourd'hui |
| `/rattrapage` | Scanner et remplir les jours non logues |
| `/aide` | Afficher l'aide complete |

### Messages directs (DM)

Tous ces mots-cles fonctionnent aussi en ecrivant directement au bot :

| Message | Description |
|---------|-------------|
| `continue` / `continuer` / `oui` | Logger le reste de la journee sur le dernier ticket |
| `hier` / `yesterday` | Changer le contexte a hier |
| `aujourd'hui` / `aujourdhui` / `today` / `auj` | Revenir a aujourd'hui |
| `rattrapage` / `catchup` | Lancer le rattrapage |
| `aide` / `help` | Afficher l'aide |
| `PROJ-123` | Logger directement sur un ticket |
| `3h sur PROJ-456, le reste sur PROJ-123` | Repartir le temps entre tickets |
| *(texte libre)* | Claude analyse et propose des tickets |

### Ticket en cours

Le "ticket en cours" est determine automatiquement :

1. **Tempo** : le dernier ticket logue dans les 7 derniers jours (par ordre de creation)
2. **Jira** : en fallback, le dernier ticket dans la categorie "In Progress"

### Suggestions Claude

Quand vous ecrivez du texte libre, Claude :
- Recoit la liste de vos tickets actifs (jusqu'a 30)
- Recoit votre activite GitHub du jour (commits + PRs)
- Propose jusqu'a 3 tickets avec un niveau de confiance : 🟢 high, 🟡 medium, 🔴 low
- Propose toujours la creation d'un nouveau ticket en option

### Rattrapage

Le mode rattrapage scanne les 12 dernieres semaines, identifie les jours non remplis, et propose semaine par semaine :
- Logger tout sur le ticket en cours
- Logger jusqu'a un jour specifique
- Laisser Claude decider a partir de l'activite GitHub
- Envoyer un ticket ou une description manuellement

---

## Structure du projet

```
src/
  index.ts              # Point d'entree
  setup.ts              # Configuration interactive
  config/index.ts       # Chargement yaml + env
  types/index.ts        # Types TypeScript
  integrations/
    slack.ts            # Bot Slack, handlers, UI blocks
    jira.ts             # API Jira REST v3
    tempo.ts            # API Tempo v4 (worklogs)
    claude.ts           # Analyse IA (matching tickets)
    github.ts           # Activite GitHub (commits, PRs)
    folks.ts            # Absences Folks HR
  services/
    timesheet.ts        # Logique metier (status, scan)
    holidays.ts         # Jours feries (FR, QC, ES)
    scheduler.ts        # Cron + detection de reveil
scripts/
  service.sh            # Gestionnaire de daemon macOS
config.yaml             # Configuration utilisateur
.env                    # Secrets (chmod 600)
```

---

## Configuration

### `config.yaml`

```yaml
user:
  jiraAccountId: "712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  slackUserId: "U0XXXXXXX"
  country: "FR"           # FR, QC, ou ES (jours feries)
  workProject: "PROJ"     # Projet Jira principal
  adminProject: "ADMIN"   # Projet admin/absence
  weeklyHours: 35
  dailyHours: 7
  reminderTime: "17:00"   # Heure du rappel quotidien
  timezone: "Europe/Paris"
  githubUsername: "monuser"
  githubOrg: "monorg"
```

### `.env`

```bash
ATLASSIAN_BASE_URL=https://moninstance.atlassian.net
ATLASSIAN_EMAIL=moi@example.com
ATLASSIAN_API_TOKEN=xxx
TEMPO_API_TOKEN=xxx
SLACK_BOT_TOKEN=xoxb-xxx
SLACK_APP_TOKEN=xapp-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
# Optionnels :
GITHUB_TOKEN=ghp_xxx
FOLKS_API_KEY=xxx
```

---

## Licence

Usage personnel.
