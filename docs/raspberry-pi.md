# Raspberry Pi 5 with OpenRouter and Telegram

Use a 64-bit Raspberry Pi OS image on the Pi 5 and run Octopus as its own
non-root account. Confirm that `uname -m` reports `aarch64` and that Node.js
24 or newer is an ARM64 build. Install the [Linux build prerequisites and
AppArmor process authority](linux.md). The Telegram connector uses Python 3.
[Raspberry Pi OS downloads](https://www.raspberrypi.com/software/operating-systems/)

## Build and configure

From the checkout on the Pi:

```sh
npm ci --prefix app
npm --prefix app run build:cli -- --target=aarch64-unknown-linux-gnu
npm --prefix app run build
```

Use the release process-authority binary from
`app/build/cli/runtime/bin/octopus-linux-process-authority` with the installer
in the Linux guide. Make sure AppArmor is active on the running kernel.
If the parser rejects the fine-grained Unix socket rule, follow the
[kernel compatibility setup](linux.md#kernels-with-coarse-unix-socket-mediation).

In the selected Home's `.env` file, set the following variables. Give the
file mode `0600`. Replace the placeholders with your OpenRouter key, BotFather
token, and numeric Telegram user ID. For a private bot chat, use the same
numeric value as the Home chat ID.

```dotenv
OCTOPUS_PROVIDER_OPENROUTER_API_KEY=<OpenRouter key>
OCTOPUS_WEB_SEARCH_PROVIDER=openrouter
TELEGRAM_BOT_TOKEN=<BotFather token>
TELEGRAM_ALLOWED_USERS=<your numeric user ID>
TELEGRAM_HOME_CHAT=<your private chat ID>
```

If you start with a new Home, select the **OpenRouter Headless** pack. The
example creates a Telegram project and selects a model from the installed
OpenRouter catalog:

```sh
./octopus setup --non-interactive --pack openrouter-headless \
  --workspace-name Octopus --project-name Telegram \
  --model deepseek/deepseek-v4.1-flash-1017 --effort none
```

Use the same `--home` path for every command if you select a non-default Home.
The pack prepares Home and new tasks with Web Search and includes Telegram for
explicit selection. Existing Homes can install the OpenRouter and Telegram
Applications and the Web Search Driver through the normal package interface.
If the runtime already started before you edited `.env`, use `./octopus down`
then `./octopus up` so its interfaces inherit the new values.

### Check the provider after an update

The ARM64 workflow records the SHA-256 of the packaged `octopus-provider-opencodex-life`
in its job summary. OpenRouter imports this executable from the `world_provider_codex`
package in the active Home. An existing Home retains its installed package when
the distribution is replaced. Stop the runtime and its supervisor, if used,
then repair the installed package from the updated checkout and distribution:

```sh
./octopus application repair world_provider_codex
```

When updating System Room, repair its Driver while the runtime is stopped.
System Room owns the door process and the `file.write` executable. Repairing an
Application checks its installed dependencies and updates the selected Application.

```sh
./octopus driver repair system_room
```

Start the runtime again after the repair succeeds. Use the same `--home`
selection as the running service and pass `--bundle` if the distribution is
outside the checkout's default location.

From the checkout, compare the packaged copy, the installed copy, and the running
provider. Set `provider_pid` to the OpenRouter provider process ID on the Pi.

```sh
home=${OCTOPUS_HOME:-"$HOME/.octopus"}
life=interface/world_provider_codex/packages/octopus-provider-codex/life-bin/octopus-provider-opencodex-life
sha256sum "app/build/cli/runtime/local-packages/registry/$life" \
  "$home/registry/$life" "/proc/$provider_pid/exe"
```

When the provider is running from the updated package, all three hashes match.

## Chat with the Telegram bot

Create a bot in @BotFather, open its private chat, and press **Start**. For a
bot previously used with webhooks, release that integration before starting
this long-polling connector. Run the headless connection command and create
an Agent with Telegram enabled:

```sh
./octopus application connect world_telegram
./octopus agent create Telegram --project Telegram \
  --provider world_provider_openrouter --model deepseek/deepseek-v4.1-flash-1017 --effort none \
  --application world_telegram
./octopus exec --project Telegram --agent Telegram \
  'For each Telegram message, respond in its chat using telegram.send_message. Use web.search when current information is needed. Acknowledge this setup here.'
```

If you do not know your numeric user ID, leave both Telegram ID variables out
of the `.env` file and follow the pairing link printed by the connection
command.

After the setup turn finishes, send a message to the bot. Keep one task
connected to this bot for a single conversation. You can inspect the task
from the CLI or WebUI. The running Octopus runtime owns Telegram polling,
so you can close the terminal client. [Telegram Bot API](https://core.telegram.org/bots/api)

When Web Search is granted, the Agent calls `web.search`. The
`OCTOPUS_WEB_SEARCH_PROVIDER` setting selects OpenRouter by default, and
`provider: "openrouter"` selects it for an individual call. The search tool
uses the same OpenRouter key, invokes `openrouter:web_search` with its
declared search model (`openai/gpt-5.2`), and returns the cited pages to the task.
OpenRouter's `auto` engine uses native provider search when the selected
endpoint supports it and falls back to Exa. Requests with explicit domain
exclusions use Exa so the exclusions are honored.
[OpenRouter Web Search](https://openrouter.ai/docs/guides/features/server-tools/web-search)

For browser and desktop connections, configure the administrator and
Turnstile variables and start `./octopus serve` using the
[Agent server guide](agent-server.md).
