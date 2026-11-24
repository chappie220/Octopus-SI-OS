# Agent server and WebUI

`octopus serve` starts or joins the existing Octopus runtime for one Home and
serves the built WebUI. The server keeps the Home, model credentials, policies,
and task records. The browser and the desktop connection window use the same
Home, Projects, Agents, and Tasks. Closing either client leaves submitted work
running. Stopping `serve` closes the WebUI. Use `octopus down` to stop the runtime.

For Raspberry Pi 5 ARM64 deployments with Telegram and OpenRouter, follow the
[Raspberry Pi guide](raspberry-pi.md).

## Start the server

Use the runtime build prerequisites from the [terminal guide](cli.md#build-and-open).
From the checkout on the server:

```sh
npm ci --prefix app
npm --prefix app run build:cli
npm --prefix app run build
```

For a new Home, run `./octopus setup` on the server and follow the prompts to
configure a workspace and model provider. For an existing Home, use the same
`--home /absolute/path` for setup and serve, or set `OCTOPUS_HOME`.

Create a **Managed** widget in Cloudflare Turnstile and allow the hostname
that operators open in their browser. Use the public HTTPS hostname for a
reverse proxy or `127.0.0.1` for loopback access. The Agent server needs
outbound HTTPS access to `challenges.cloudflare.com`.
[Cloudflare widget setup](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)

Set these four variables in the Agent server process environment.

| Variable | Value |
| --- | --- |
| `OCTOPUS_CLIENT_ADMIN_USERNAME` | Username for the server's administrator account |
| `OCTOPUS_CLIENT_ADMIN_SECRET` | Administrator password of at least eight characters |
| `OCTOPUS_TURNSTILE_SITE_KEY` | Public site key for the Managed widget |
| `OCTOPUS_TURNSTILE_SECRET_KEY` | Private secret key for the same widget |

In Bash, you can enter the two secrets without echoing them or recording them
in shell history:

```bash
export OCTOPUS_CLIENT_ADMIN_USERNAME=operator
read -rp 'Turnstile site key: ' OCTOPUS_TURNSTILE_SITE_KEY
read -rsp 'Agent administrator password: ' OCTOPUS_CLIENT_ADMIN_SECRET
printf '\n'
read -rsp 'Turnstile secret key: ' OCTOPUS_TURNSTILE_SECRET_KEY
printf '\n'
export OCTOPUS_CLIENT_ADMIN_SECRET OCTOPUS_TURNSTILE_SITE_KEY OCTOPUS_TURNSTILE_SECRET_KEY
./octopus serve
```

Open **http://127.0.0.1:4180** in a browser. Enter the username and password
and complete the verification shown by Turnstile. The server validates the
challenge before it creates a session. Change the credentials by updating
the server environment and restarting `serve`. For another port use
`./octopus serve --port 4181`. Inspect the runtime with `./octopus status`.
[Cloudflare server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## Connect from another machine

The HTTP listener binds to `127.0.0.1`. For an SSH tunnel, forward the same
port and open the loopback URL on your machine:

```sh
ssh -N -L 4180:127.0.0.1:4180 user@server
```

For a persistent HTTPS address, start `serve` with
`OCTOPUS_AGENT_PUBLIC_ORIGIN=https://agent.example.com` and route that origin
to `127.0.0.1:4180` on the server. The proxy must preserve the public
`Host` header and stream `/__octopus/events` without buffering. Both the UI
and API use the root of that same origin.

## Desktop client

In the macOS app, choose **File → Connect to Agent Server…** and enter the
browser URL. To launch directly into server-client mode, quit Octopus and run:

```sh
open -a Octopus --args --server=https://agent.example.com
```

You can also set `OCTOPUS_AGENT_SERVER_URL` when invoking the desktop
executable. Server-client mode uses the WebUI and its session. The local
desktop mode still supports native workflows.

Use the connected clients for Home and Task conversations, task history and
live updates, and Project and Agent management. Perform provider sign-in and
initial setup on the server. Native file attachment staging, local desktop
and browser controls, and package installation are available through their
existing local workflows.
