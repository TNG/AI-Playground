# AI Playground

Desktop app for running AI inference locally on Intel GPUs, with optional cloud models.

## Language

### Installation

**Setup Wizard**:
The in-app screen for choosing a product mode and enabling AI Playground components.
_Avoid_: Install wizard (that is the Installer)

**Installer**:
The Windows setup program that places AI Playground on disk, per user or for all users.
_Avoid_: Install wizard, setup wizard

**Shared Install**:
An installation done by the Installer for all users of a machine.
_Avoid_: Multi-user install, machine install, all-users install

### Demo Mode

**Demo Mode**:
A locked-down state for public or classroom machines that hides configuration and resets the app after a period of inactivity.
_Avoid_: Kiosk mode

**Demo Policy**:
The machine-wide Demo Mode configuration an administrator sets on a Shared Install; when present it overrides every user's own Demo Mode settings.
_Avoid_: Forced demo mode, registry setting

**Demo Passcode**:
The secret that lets someone leave Demo Mode.
_Avoid_: Password, demo key

**Reset Timeout**:
How long the app may sit idle in Demo Mode before it resets to a clean state.
_Avoid_: Demo timeout
