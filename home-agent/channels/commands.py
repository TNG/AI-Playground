"""Single source of truth for Home Agent slash commands.

Both channel transports (`telegram.py`, `slack.py`) build their command
handlers and platform command menus from `HOME_AGENT_COMMANDS`, so a command
can never be wired into one transport but silently forgotten in another (the
class of bug where `/reset` worked in the dispatcher but was never registered
with Telegram or Slack).

This list only governs how a *transport* recognizes a slash command and what
raw text it forwards. Two further, TypeScript-side touch-points are NOT covered
here and must be kept in sync by hand — see AGENTS.md "Home Agent slash
commands" for the full checklist:

  * the router's command table in `WebUI/src/assets/js/store/channels/`
    (`answerRouter.ts`, `channelSessions.ts`, `channelAgents.ts`: the behavior
    and the `/help` text), and
  * the Slack app manifest in `WebUI/src/components/SlackSetupSteps.vue`
    (`slash_commands`), which the user copies into Slack.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HomeAgentCommand:
    """One slash command, described once for every channel transport.

    name:             canonical lowercase trigger. Slack slash commands must be
                      lowercase, and Telegram's command menu must be lowercase.
    description:      shown in the Telegram command menu / Slack manifest.
    takes_args:       whether free text after the command is forwarded along.
    queued:           the exact text handed to the renderer-side dispatcher.
                      Defaults to ``/<name>``; override when the dispatcher
                      expects a different spelling (e.g. ``/imgGen``).
    telegram_aliases: extra Telegram-only trigger spellings that resolve to the
                      same command (e.g. ``imgGen`` for camelCase parity, or
                      ``start`` -> help). These never appear in the menu.
    """

    name: str
    description: str
    takes_args: bool = False
    queued: str | None = None
    telegram_aliases: tuple[str, ...] = ()

    @property
    def queued_text(self) -> str:
        return self.queued if self.queued is not None else f"/{self.name}"

    @property
    def slash(self) -> str:
        return f"/{self.name}"

    def build_full_text(self, args: list[str] | None) -> str:
        """Assemble the text forwarded to the dispatcher for this invocation."""
        if self.takes_args and args:
            return f"{self.queued_text} {' '.join(args)}".strip()
        return self.queued_text


# Order is preserved for the Telegram command menu and the Slack manifest.
HOME_AGENT_COMMANDS: tuple[HomeAgentCommand, ...] = (
    HomeAgentCommand("help", "Show available commands", telegram_aliases=("start",)),
    HomeAgentCommand("sessions", "List your Reachable Sessions to pick one"),
    HomeAgentCommand(
        "load", "Continue a Session (no number = pick from a list)", takes_args=True
    ),
    HomeAgentCommand("new", "Start a new Session"),
    HomeAgentCommand(
        "agents",
        "List the agents you can start, or start one by name",
        takes_args=True,
    ),
    HomeAgentCommand(
        "stop", "Stop the running turn or Agent Run and drop queued messages"
    ),
)

# A tap on a router button with one of these prefixes is forwarded as that command,
# its value the argument. Telegram and Slack only deliver taps on known prefixes.
COMMAND_CALLBACKS: dict[str, str] = {"loadConv:": "/load", "runAgent:": "/agents"}


def command_for_callback(data: str) -> str | None:
    """The command a tapped router button stands for; None for any other button."""
    for prefix, command in COMMAND_CALLBACKS.items():
        if data.startswith(prefix):
            return f"{command} {data[len(prefix) :]}".strip()
    return None
