#!/usr/bin/env bash
# Install or update japa with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | bash
#
# It clones (or updates) the repo, brings its own Node 24 if the machine has none, asks for the keys on first install,
# and runs the agent as a systemd service that restarts on failure and on boot. Run it again to update.
#
# Every question can be answered ahead of time through the environment, for an unattended install:
#   TELEGRAM_BOT_TOKEN, JAPA_TELEGRAM_ID   the bot, and your own Telegram user id (the allowlist)
#   JAPA_PROVIDER, JAPA_MODEL_KEY          a pi-ai provider and its API key
#   JAPA_MODEL, JAPA_FAST_MODEL            the main model and the fast one (reviews, summaries)
#   JAPA_NAME, JAPA_TIMEZONE               who the agent works for, and their zone
#   BOAT_API_KEY, PARALLEL_API_KEY         the agent's own computer (boat.dev) and web search (optional)
# and where it goes: JAPA_DIR (default ~/japa), JAPA_REPO, JAPA_BRANCH, JAPA_SERVICE (auto | system | user | none),
# JAPA_CONFIGURE=1 to ask everything again on an existing install.
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

if [ -d "$DIR/.git" ]; then
	say "Updating $DIR"
	git -C "$DIR" pull --ff-only --quiet origin "$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
	die "$DIR exists and isn't a japa checkout; set JAPA_DIR to install elsewhere"
else
	say "Cloning into $DIR"
	git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

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

# --- First install: keys and settings, all in data/ (gitignored, readable only by you) --------------------------------

mkdir -p data && chmod 700 data
if [ ! -f data/settings.json ] || [ "${JAPA_CONFIGURE:-}" = 1 ]; then
	[ -n "$TTY" ] || [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || die "no terminal to ask on: set TELEGRAM_BOT_TOKEN and the other answers in the environment"

	say "Telegram"
	note "Create a bot with @BotFather and paste its token."
	ask TELEGRAM_BOT_TOKEN "Bot token" "" secret
	[ -n "$TELEGRAM_BOT_TOKEN" ] || die "a bot token is needed"
	note "Only Telegram users on the allowlist get through. Leave this empty to find your id with /whoami after it starts."
	ask JAPA_TELEGRAM_ID "Your Telegram user id"

	say "Model"
	note "Any pi-ai provider, e.g. anthropic, openai, google, openrouter, zai, deepseek, xai."
	ask JAPA_PROVIDER "Provider" "anthropic"
	models="$("$NODE" --input-type=module -e '
		import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
		const provider = process.argv[1];
		if (!getBuiltinProviders().includes(provider)) process.exit(1);
		console.log(getBuiltinModels(provider).map((model) => model.id).join(" "));
	' "$JAPA_PROVIDER")" || die "unknown provider: $JAPA_PROVIDER"
	case "$JAPA_PROVIDER" in
		anthropic) main_default=claude-sonnet-5-5 fast_default=claude-haiku-4-5 ;;
		zai) main_default=glm-5.3 fast_default=glm-5.3-flash ;;
		*)
			main_default='' fast_default=''
			note "Its models: $models"
			;;
	esac
	ask JAPA_MODEL "Main model (the chief of staff)" "$main_default"
	ask JAPA_FAST_MODEL "Fast model (approvals, summaries)" "${fast_default:-$JAPA_MODEL}"
	for model in "$JAPA_MODEL" "$JAPA_FAST_MODEL"; do
		[[ " $models " == *" $model "* ]] || die "$JAPA_PROVIDER has no model $model"
	done
	ask JAPA_MODEL_KEY "$JAPA_PROVIDER API key (empty: log in with a subscription instead)" "" secret
	if [ -n "$JAPA_MODEL_KEY" ]; then
		JAPA_PROVIDER="$JAPA_PROVIDER" JAPA_MODEL_KEY="$JAPA_MODEL_KEY" "$NODE" -e '
			const { existsSync, readFileSync, writeFileSync } = require("node:fs");
			const all = existsSync("data/auth.json") ? JSON.parse(readFileSync("data/auth.json", "utf8")) : {};
			all[process.env.JAPA_PROVIDER] = { type: "api_key", key: process.env.JAPA_MODEL_KEY };
			writeFileSync("data/auth.json", JSON.stringify(all, null, "\t") + "\n", { mode: 0o600 });
		'
	else
		[ -n "$TTY" ] || die "set JAPA_MODEL_KEY for an unattended install"
		(cd data && "$DIR/node_modules/.bin/pi-ai" login "$JAPA_PROVIDER" <"$TTY")
		[ -f data/auth.json ] || die "no login saved"
	fi

	say "You"
	ask JAPA_NAME "Your name (optional)"
	ask JAPA_TIMEZONE "Your time zone" "$("$NODE" -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')"

	say "Optional extras (Enter to skip; all of them can be set later)"
	note "boat.dev gives the agent its own computer for shell, files and coding agents. Without it, it has none:"
	note "agent code never runs on this machine."
	ask BOAT_API_KEY "boat.dev API key" "" secret
	note "Parallel powers web search (also settable later in /settings → Web)."
	ask PARALLEL_API_KEY "Parallel API key" "" secret

	umask 077
	{
		echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
		if [ -n "$BOAT_API_KEY" ]; then echo "BOAT_API_KEY=$BOAT_API_KEY"; fi
		if [ -n "$PARALLEL_API_KEY" ]; then echo "PARALLEL_API_KEY=$PARALLEL_API_KEY"; fi
	} >data/.env
	umask 022
	chmod 600 data/.env

	JAPA_PROVIDER="$JAPA_PROVIDER" JAPA_MODEL="$JAPA_MODEL" JAPA_FAST_MODEL="$JAPA_FAST_MODEL" JAPA_NAME="$JAPA_NAME" \
		JAPA_TIMEZONE="$JAPA_TIMEZONE" JAPA_TELEGRAM_ID="$JAPA_TELEGRAM_ID" BOAT="${BOAT_API_KEY:+1}" "$NODE" --input-type=module -e '
		import { existsSync, readFileSync, writeFileSync } from "node:fs";
		import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
		const env = process.env;
		const settings = existsSync("data/settings.json") ? JSON.parse(readFileSync("data/settings.json", "utf8")) : {};
		const choice = (modelId) => ({ provider: env.JAPA_PROVIDER, modelId });
		const sees = (modelId) => getBuiltinModel(env.JAPA_PROVIDER, modelId)?.input?.includes("image");
		settings.model = choice(env.JAPA_MODEL);
		settings.delegateModel = choice(env.JAPA_MODEL);
		settings.jobModels = { fast: choice(env.JAPA_FAST_MODEL), strong: choice(env.JAPA_MODEL) };
		const vision = [env.JAPA_MODEL, env.JAPA_FAST_MODEL].find(sees);
		if (vision !== undefined) settings.jobModels.vision = choice(vision);
		if (env.JAPA_NAME) settings.user = { ...settings.user, name: env.JAPA_NAME };
		if (env.JAPA_TIMEZONE) settings.timezone = env.JAPA_TIMEZONE;
		settings.allowlist ??= {};
		if (/^\d+$/.test(env.JAPA_TELEGRAM_ID ?? "")) settings.allowlist.telegram = [Number(env.JAPA_TELEGRAM_ID)];
		settings.allowlist.telegram ??= [];
		settings.machines ??= {};
		if (env.BOAT) settings.machines.workbench ??= { provider: "boat", type: "small", screen: true, idleSeconds: 7200 };
		writeFileSync("data/settings.json", JSON.stringify(settings, null, "\t") + "\n");
	'
fi

# Memory: a git repo of its own, so every change the agent makes to it is a commit you can read and undo.
HOME_REPO="${JARVIS_HOME:-$HOME/jarvis-home}"
if [ ! -d "$HOME_REPO/.git" ]; then
	mkdir -p "$HOME_REPO"
	git -C "$HOME_REPO" init --quiet
	git -C "$HOME_REPO" config user.name "$NAME"
	git -C "$HOME_REPO" config user.email "$NAME@localhost"
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
		EnvironmentFile=$DIR/data/.env
		Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
		ExecStart=$NODE $DIR/src/main.ts
		Restart=always
		RestartSec=5
		StandardOutput=append:$DIR/data/jarvis.log
		StandardError=append:$DIR/data/jarvis.log

		[Install]
		WantedBy=$2
	EOF
}

log_from=$(stat -c %s data/jarvis.log 2>/dev/null || echo 0)
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
		note "cd $DIR && set -a && . data/.env && set +a && $NODE src/main.ts"
		exit 0
		;;
	*) die "JAPA_SERVICE must be auto, system, user or none" ;;
esac

# --- Is it up? ---------------------------------------------------------------------------------------------------------

new_log() { tail -c +"$((log_from + 1))" data/jarvis.log 2>/dev/null || true; }
for _ in $(seq 60); do
	if new_log | grep -q "telegram: polling as @"; then break; fi
	sleep 1
done
bot="$(new_log | grep -o "polling as @[A-Za-z0-9_]*" | tail -1 | cut -d@ -f2)"
if [ -z "$bot" ]; then
	note "It hasn't connected to Telegram yet. The log so far:"
	new_log | tail -20 >&2
	die "see $DIR/data/jarvis.log"
fi
say "Running as @$bot"

allowed="$("$NODE" -p 'String(JSON.parse(require("fs").readFileSync("data/settings.json", "utf8")).allowlist?.telegram?.length ?? 0)')"
if [ "$allowed" = 0 ] && [ -n "$TTY" ]; then
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
				const settings = JSON.parse(fs.readFileSync("data/settings.json", "utf8"));
				settings.allowlist = { ...settings.allowlist, telegram: [Number(process.env.ID)] };
				fs.writeFileSync("data/settings.json", JSON.stringify(settings, null, "\t") + "\n");
			'
			note "Done: say hello to @$bot."
		fi
	else
		note "Nothing yet. Later, put your id in \"allowlist\": { \"telegram\": [...] } in $DIR/data/settings.json."
	fi
fi

say "Installed in $DIR"
note "Settings: /settings in Telegram, or $DIR/data/settings.json (live, no restart)"
note "Log: $DIR/data/jarvis.log"
note "Service: $manage"
note "Update: run the same install command again"
