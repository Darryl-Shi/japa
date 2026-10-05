#!/usr/bin/env bash
# Install or update japa with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | bash
#
# It clones (or updates) the repo, brings its own Node 24 if the machine has none, asks for the keys on first install,
# and runs the agent as a systemd service that restarts on failure and on boot. The machine it's installed on is the
# agent's computer: its shell, files and screen are this machine's, as the user it's installed as. Run it again to
# update: it pulls the latest code, reinstalls dependencies, keeps your settings, keys and data (moving any from older
# layouts), and restarts the service.
#
# This sets up the defaults: Telegram as the channel, optionally one pi-ai model provider (or log in later with /login),
# and optionally Parallel for web search.
# Everything else (other providers through /login, other channels as extensions) is done from chat. Every question can
# be answered ahead of time through the environment:
#   TELEGRAM_BOT_TOKEN, JAPA_TELEGRAM_ID   the bot, and your own Telegram user id (the allowlist)
#   JAPA_PROVIDER, JAPA_MODEL_KEY          a pi-ai provider and its API key
#   JAPA_MODEL, JAPA_FAST_MODEL            the main model and the fast one (reviews, summaries)
#   JAPA_NAME, JAPA_TIMEZONE               who the agent works for, and their zone
#   PARALLEL_API_KEY                       web search (optional)
# and where it goes: JAPA_DIR (the code, default ~/japa), JAPA_DATA (everything it keeps, default $JAPA_DIR/data),
# JAPA_REPO, JAPA_BRANCH, JAPA_SERVICE (auto | system | user | none), JAPA_CONFIGURE=1 to ask everything again.
set -euo pipefail

REPO="${JAPA_REPO:-https://github.com/Darryl-Shi/japa.git}"
BRANCH="${JAPA_BRANCH:-main}"
DIR="${JAPA_DIR:-$HOME/japa}"
SERVICE="${JAPA_SERVICE:-auto}"
NAME=japa
NODE_MAJOR=24

say() { printf '\n\033[1m%s\033[0m\n' "$*" >&2; }
note() { printf '  %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Questions go to the terminal even when this script arrives through a pipe. With no terminal, answers come only from
# the environment.
TTY=
if (: </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask VAR "question" [default] [secret]: leaves an answer already in the environment alone.
ask() {
	local var=$1 question=$2 default=${3:-} secret=${4:-} answer=
	if [ -n "${!var:-}" ]; then return; fi
	if [ -n "$TTY" ]; then
		local prompt="  $question"
		if [ -n "$default" ]; then prompt+=" [$default]"; fi
		if [ -n "$secret" ]; then
			read -r -s -p "$prompt: " answer <"$TTY"
			printf '\n' >&2
		else
			read -r -p "$prompt: " answer <"$TTY"
		fi
	fi
	printf -v "$var" '%s' "${answer:-$default}"
}

sudo_ok() { [ "$(id -u)" = 0 ] || { have sudo && { sudo -n true 2>/dev/null || [ -n "$TTY" ]; }; }; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# --- Tools -----------------------------------------------------------------------------------------------------------

for tool in git curl tar; do
	if have "$tool"; then continue; fi
	if have apt-get && sudo_ok; then
		say "Installing $tool"
		as_root apt-get update -qq && as_root apt-get install -y -qq "$tool" >/dev/null
	else
		die "$tool is needed; install it and run this again"
	fi
done

# --- The code --------------------------------------------------------------------------------------------------------

# Pulled (or cloned) once; the handed-over run below finds it done.
if [ -z "${JAPA_HANDED_OVER:-}" ]; then
	if [ -d "$DIR/.git" ]; then
		say "Updating $DIR"
		git -C "$DIR" pull --ff-only --quiet origin "$BRANCH"
	elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
		die "$DIR exists and isn't a japa checkout; set JAPA_DIR to install elsewhere"
	else
		say "Cloning into $DIR"
		git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
	fi
fi
cd "$DIR"

# Carry on with the installer just pulled, so an update always runs the latest one (the copy piped in can be minutes
# stale behind GitHub's cache).
if [ -z "${JAPA_HANDED_OVER:-}" ]; then
	JAPA_HANDED_OVER=1 exec bash "$DIR/install.sh"
fi

# --- Node 24: the machine's own if it's new enough, otherwise a private copy in .node/ ---------------------------------

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ -x "$DIR/.node/bin/node" ] && [ "$(node_major "$DIR/.node/bin/node")" -ge "$NODE_MAJOR" ]; then
	NODE="$DIR/.node/bin/node"
elif have node && [ "$(node_major node)" -ge "$NODE_MAJOR" ]; then
	NODE="$(command -v node)"
else
	say "Installing Node $NODE_MAJOR (into $DIR/.node)"
	case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS: $(uname -s)" ;; esac
	case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac
	base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
	sums="$(curl -fsSL "$base/SHASUMS256.txt")"
	file="$(awk -v want="-$os-$arch.tar.gz" 'substr($2, length($2) - length(want) + 1) == want { print $2; exit }' <<<"$sums")"
	[ -n "$file" ] || die "no Node $NODE_MAJOR build for $os-$arch"
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	curl -fsSL "$base/$file" -o "$tmp/$file"
	expected="$(awk -v f="$file" '$2 == f { print $1 }' <<<"$sums")"
	actual="$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | awk '{ print $1 }')"
	[ "$expected" = "$actual" ] || die "checksum mismatch for $file"
	rm -rf "$DIR/.node" && mkdir -p "$DIR/.node"
	tar -xzf "$tmp/$file" -C "$DIR/.node" --strip-components=1
	NODE="$DIR/.node/bin/node"
fi
PATH="$(dirname "$NODE"):$PATH"
export PATH
note "node $("$NODE" --version)"

say "Installing dependencies"
npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error

# --- Everything it keeps is in one directory (readable only by you) ---------------------------------------------------

DATA="${JAPA_DATA:-$DIR/data}"
DATA="$(mkdir -p "$DATA" && cd "$DATA" && pwd)"
chmod 700 "$DATA"
export JAPA_DATA="$DATA"

# Older layouts: memory in ~/jarvis-home (JARVIS_HOME), the log as jarvis.log.
OLD_MEMORY="${JARVIS_HOME:-$HOME/jarvis-home}"
if [ -d "$OLD_MEMORY" ] && [ ! -e "$DATA/memory" ]; then
	note "Moving memory from $OLD_MEMORY to $DATA/memory"
	mv "$OLD_MEMORY" "$DATA/memory"
fi
if [ -f "$DATA/jarvis.log" ] && [ ! -e "$DATA/japa.log" ]; then mv "$DATA/jarvis.log" "$DATA/japa.log"; fi

# --- First install: keys and settings ----------------------------------------------------------------------------------

if [ ! -f "$DATA/settings.json" ] || [ "${JAPA_CONFIGURE:-}" = 1 ]; then
	[ -n "$TTY" ] || [ -n "${TELEGRAM_BOT_TOKEN:-}${JAPA_PROVIDER:-}" ] || die "no terminal to ask on: set the answers in the environment"

	say "Telegram (the default channel)"
	note "Create a bot with @BotFather and paste its token. Empty: no Telegram (bring another channel as an extension)."
	ask TELEGRAM_BOT_TOKEN "Bot token" "" secret
	if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
		note "Only Telegram users on the allowlist get through. Leave this empty to find your id with /whoami after it starts."
		ask JAPA_TELEGRAM_ID "Your Telegram user id"
	fi

	say "Model"
	providers="$("$NODE" --input-type=module -e '
		import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
		console.log(getBuiltinProviders().join(" "));
	')"
	note "Any pi-ai provider: $providers"
	note "Empty: none yet; log in with /login in chat and pick models in /settings. (More, and other logins, there too.)"
	ask JAPA_PROVIDER "Provider"
	if [ -n "$JAPA_PROVIDER" ]; then
		models="$("$NODE" --input-type=module -e '
			import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
			const provider = process.argv[1];
			if (!getBuiltinProviders().includes(provider)) process.exit(1);
			console.log(getBuiltinModels(provider).map((model) => model.id).join(" "));
		' "$JAPA_PROVIDER")" || die "unknown provider: $JAPA_PROVIDER"
		note "Its models: $models"
		ask JAPA_MODEL "Main model (the chief of staff)"
		ask JAPA_FAST_MODEL "Fast model (approvals, summaries)" "$JAPA_MODEL"
		for model in "$JAPA_MODEL" "$JAPA_FAST_MODEL"; do
			[[ " $models " == *" $model "* ]] || die "$JAPA_PROVIDER has no model $model"
		done
		ask JAPA_MODEL_KEY "$JAPA_PROVIDER API key (empty: log in with a subscription instead)" "" secret
		if [ -n "$JAPA_MODEL_KEY" ]; then
			JAPA_PROVIDER="$JAPA_PROVIDER" JAPA_MODEL_KEY="$JAPA_MODEL_KEY" "$NODE" -e '
				const { existsSync, readFileSync, writeFileSync } = require("node:fs");
				const file = `${process.env.JAPA_DATA}/auth.json`;
				const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
				all[process.env.JAPA_PROVIDER] = { type: "api_key", key: process.env.JAPA_MODEL_KEY };
				writeFileSync(file, JSON.stringify(all, null, "\t") + "\n", { mode: 0o600 });
			'
		else
			[ -n "$TTY" ] || die "set JAPA_MODEL_KEY for an unattended install"
			(cd "$DATA" && "$DIR/node_modules/.bin/pi-ai" login "$JAPA_PROVIDER" <"$TTY")
			[ -f "$DATA/auth.json" ] || die "no login saved"
		fi
	fi

	say "You"
	ask JAPA_NAME "Your name (optional)"
	ask JAPA_TIMEZONE "Your time zone" "$("$NODE" -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')"

	say "Optional extras (Enter to skip; all of them can be set later)"
	note "Parallel powers web search (also settable later in /settings → Web)."
	ask PARALLEL_API_KEY "Parallel API key" "" secret

	umask 077
	{
		if [ -n "$TELEGRAM_BOT_TOKEN" ]; then echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"; fi
		if [ -n "$PARALLEL_API_KEY" ]; then echo "PARALLEL_API_KEY=$PARALLEL_API_KEY"; fi
	} >"$DATA/.env"
	umask 022
	chmod 600 "$DATA/.env"

	JAPA_PROVIDER="$JAPA_PROVIDER" JAPA_MODEL="$JAPA_MODEL" JAPA_FAST_MODEL="$JAPA_FAST_MODEL" JAPA_NAME="$JAPA_NAME" \
		JAPA_TIMEZONE="$JAPA_TIMEZONE" JAPA_TELEGRAM_ID="$JAPA_TELEGRAM_ID" "$NODE" --input-type=module -e '
		import { existsSync, readFileSync, writeFileSync } from "node:fs";
		import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
		const env = process.env;
		const file = `${env.JAPA_DATA}/settings.json`;
		const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
		if (env.JAPA_PROVIDER) {
			const choice = (modelId) => ({ provider: env.JAPA_PROVIDER, modelId });
			const sees = (modelId) => getBuiltinModel(env.JAPA_PROVIDER, modelId)?.input?.includes("image");
			settings.model = choice(env.JAPA_MODEL);
			settings.delegateModel = choice(env.JAPA_MODEL);
			settings.jobModels = { fast: choice(env.JAPA_FAST_MODEL), strong: choice(env.JAPA_MODEL) };
			const vision = [env.JAPA_MODEL, env.JAPA_FAST_MODEL].find(sees);
			if (vision !== undefined) settings.jobModels.vision = choice(vision);
		}
		if (env.JAPA_NAME) settings.user = { ...settings.user, name: env.JAPA_NAME };
		if (env.JAPA_TIMEZONE) settings.timezone = env.JAPA_TIMEZONE;
		settings.allowlist ??= {};
		if (/^\d+$/.test(env.JAPA_TELEGRAM_ID ?? "")) settings.allowlist.telegram = [Number(env.JAPA_TELEGRAM_ID)];
		writeFileSync(file, JSON.stringify(settings, null, "\t") + "\n");
	'
fi

# Memory: a git repo of its own, so every change the agent makes to it is a commit you can read and undo.
if [ ! -d "$DATA/memory/.git" ]; then
	mkdir -p "$DATA/memory"
	git -C "$DATA/memory" init --quiet
	git -C "$DATA/memory" config user.name "$NAME"
	git -C "$DATA/memory" config user.email "$NAME@localhost"
fi

# --- The service -----------------------------------------------------------------------------------------------------

if [ "$SERVICE" = auto ]; then
	if ! have systemctl || [ ! -d /run/systemd/system ]; then SERVICE=none
	elif sudo_ok; then SERVICE=system
	else SERVICE=user
	fi
fi

unit() {
	cat <<-EOF
		[Unit]
		Description=japa, a personal chief of staff
		After=network-online.target
		Wants=network-online.target

		[Service]
		$1
		WorkingDirectory=$DIR
		EnvironmentFile=-$DATA/.env
		Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
		Environment=JAPA_DATA=$DATA
		ExecStart=$NODE $DIR/src/main.ts
		Restart=always
		RestartSec=5
		StandardOutput=append:$DATA/japa.log
		StandardError=append:$DATA/japa.log

		[Install]
		WantedBy=$2
	EOF
}

LOG="$DATA/japa.log"
log_from=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
case "$SERVICE" in
	system)
		say "Starting the $NAME service"
		unit "User=$(id -un)" multi-user.target | as_root tee /etc/systemd/system/$NAME.service >/dev/null
		as_root systemctl daemon-reload
		as_root systemctl enable --quiet $NAME
		as_root systemctl restart $NAME
		manage="sudo systemctl {status|restart|stop} $NAME"
		;;
	user)
		say "Starting the $NAME service (as your user)"
		# Run through sudo -u or su, there's no login session to say where the user's service manager is.
		export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
		mkdir -p "$HOME/.config/systemd/user"
		unit "" default.target >"$HOME/.config/systemd/user/$NAME.service"
		loginctl enable-linger "$(id -un)" 2>/dev/null || note "Couldn't enable lingering: it will stop when you log out."
		systemctl --user daemon-reload
		systemctl --user enable --quiet $NAME
		systemctl --user restart $NAME
		manage="systemctl --user {status|restart|stop} $NAME"
		;;
	none)
		say "Installed. No systemd here, so start it yourself:"
		note "cd $DIR && set -a && . $DATA/.env && set +a && JAPA_DATA=$DATA $NODE src/main.ts"
		exit 0
		;;
	*) die "JAPA_SERVICE must be auto, system, user or none" ;;
esac

# --- Is it up? ---------------------------------------------------------------------------------------------------------

new_log() { tail -c +"$((log_from + 1))" "$LOG" 2>/dev/null || true; }
for _ in $(seq 60); do
	if new_log | grep -q "japa: ready"; then break; fi
	sleep 1
done
if ! new_log | grep -q "japa: ready"; then
	note "It hasn't started yet. The log so far:"
	new_log | tail -20 >&2
	die "see $LOG"
fi
say "Running"

# The default channel: once the bot is connected, put its owner on the allowlist if no one is yet.
for _ in $(seq 15); do
	if new_log | grep -q "telegram: polling as @"; then break; fi
	sleep 1
done
bot="$(new_log | grep -o "polling as @[A-Za-z0-9_]*" | tail -1 | cut -d@ -f2)"
allowed="$("$NODE" -p 'String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).allowlist?.telegram?.length ?? 0)' "$DATA/settings.json")"
if [ -n "$bot" ] && [ "$allowed" = 0 ] && [ -n "$TTY" ]; then
	say "Send /whoami to @$bot in Telegram (waiting up to 5 minutes)"
	for _ in $(seq 300); do
		id="$(new_log | grep -o "telegram: refused user [0-9]*" | tail -1 | awk '{ print $4 }')"
		if [ -n "$id" ]; then break; fi
		sleep 1
	done
	if [ -n "${id:-}" ]; then
		ask CONFIRM "Let Telegram user $id talk to it? (y/n)" "y"
		if [ "$CONFIRM" = y ]; then
			ID="$id" "$NODE" -e '
				const fs = require("node:fs");
				const file = process.argv[1];
				const settings = JSON.parse(fs.readFileSync(file, "utf8"));
				settings.allowlist = { ...settings.allowlist, telegram: [Number(process.env.ID)] };
				fs.writeFileSync(file, JSON.stringify(settings, null, "\t") + "\n");
			' "$DATA/settings.json"
			note "Done: say hello to @$bot."
		fi
	else
		note "Nothing yet. Later, put your id in \"allowlist\": { \"telegram\": [...] } in $DATA/settings.json."
	fi
fi

say "Installed in $DIR"
note "Settings: /settings in chat, or $DATA/settings.json (live, no restart)"
note "Model logins: /login in chat"
note "Log: $LOG"
note "Service: $manage"
note "Update: run the same install command again"
