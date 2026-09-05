# SDJFAM Chat

SDJFAM Chat is a Windows desktop streaming companion for Twitch and YouTube.

It brings live chat, stream status, viewer information, Twitch EventSub events, alerts and the SDJFAM Event Engine together in one app.

> Powered by SDJFAM

## Current Version

**v0.1.3**

## Features

- Twitch live chat

- YouTube live chat

- Twitch viewer count

- YouTube livestream status

- Twitch EventSub integration

- Follow events

- Subscription events

- Gift subscription events

- Bits events

- Raid events

- SDJFAM Event Engine

- In-app alert overlays

- Built-in event simulator for testing

- YouTube OAuth connection

- Automatic update support

- Windows desktop app

## Event Engine

SDJFAM Chat includes its own event layer.

Supported Twitch events currently include:

- Follow

- Subscription

- Gift Subscription

- Bits

- Raid

- Stream Online

- Stream Offline

Events are normalized by the SDJFAM Event Engine before being used by the interface and alert system.

This makes it easier to add new platforms and SDJFAM modules later without tying every feature directly to one streaming platform.

## Alerts

SDJFAM Chat currently supports in-app alerts for:

- Follows

- Subscriptions

- Gift Subs

- Bits

- Raids

The alert system is still under active development and will continue to gain more customization and automation features.

## Twitch

SDJFAM Chat connects to Twitch for:

- Live chat

- Viewer information

- EventSub events

- Stream status

## YouTube

SDJFAM Chat connects to YouTube for:

- Live chat

- Livestream detection

- Viewer information

- Google OAuth authentication

## Automatic Updates

SDJFAM Chat includes an automatic updater.

New Windows releases are built and published through GitHub Actions and can be installed from within the application.

## In Development

SDJFAM is actively being developed.

Planned areas include:

- Alert queue

- Custom alert designs

- Alert sounds and media

- OBS control

- Stream automation

- TikTok integration

- Bot and moderation tools

- Goals and giveaways

- Clips

- Analytics

- Remote control

- Stream profiles

- Plugin support

- SDJFAM Studio

## Vision

SDJFAM is being built as a larger streamer ecosystem.

The long-term goal is to bring chat, alerts, automation, stream control, analytics and broadcasting tools together under one platform while keeping integrations with existing software such as OBS.

## Tech Stack

- Tauri

- React

- TypeScript

- Vite

- Rust

- Twitch EventSub

- YouTube APIs

## Platform

Current primary platform: **Windows**

## Development Status

SDJFAM Chat is currently in active development.

The application is being tested in real streaming workflows before broader public release.

## Repository

This repository contains the source code for SDJFAM Chat.

Sensitive credentials, OAuth secrets, local tokens and private configuration files are not stored in the repository.

---

**SDJFAM Chat**

Twitch + YouTube streaming companion

**Powered by SDJFAM**
