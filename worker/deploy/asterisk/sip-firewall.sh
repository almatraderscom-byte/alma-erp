#!/usr/bin/env bash
# ALMA self-hosted SIP — port hardening (Phase 3, APPLIED + VERIFIED LIVE 2026-07-25)
#
# WHY: with SIP open to the world, scanners hammer the signalling ports non-stop —
# measured live before this rule: 281 packets in 20s from a single scanner
# (163.172.111.45), plus others. Every one of those makes Asterisk parse attacker input.
# After the rule the flood stopped reaching Asterisk entirely.
#
# WHAT: allow SIP signalling ONLY from our trunk, drop the rest. Deliberately surgical —
# it touches UDP 5060/5062 and nothing else, so SSH, the worker/bot HTTP ports and the
# RTP media range (10000-20000) are untouched and cannot be locked out by this script.
#
# VERIFY AFTER RUNNING (the trunk path must still work):
#   asterisk -rx "pjsip send register alma-reg" ; sleep 8
#   asterisk -rx "pjsip show registrations"      # expect: Registered
# ROLLBACK (instant):
#   iptables -D INPUT -p udp --dport 5060 -j DROP
#   iptables -D INPUT -p udp --dport 5062 -j DROP
#
# NOTE ON REBOOTS: plain iptables rules do NOT survive a reboot. That fails OPEN (the
# line keeps working, the hardening is simply gone), so it can never cause an outage —
# but re-run this script after any VPS reboot, or install iptables-persistent.
set -euo pipefail

TRUNK="${SIP_TRUNK_IP:-103.170.231.10}"

if iptables -C INPUT -p udp --dport 5060 -j DROP 2>/dev/null; then
  echo "SIP firewall already applied"
else
  iptables -A INPUT -p udp --dport 5060 -s "$TRUNK" -j ACCEPT
  iptables -A INPUT -p udp --dport 5062 -s "$TRUNK" -j ACCEPT
  iptables -A INPUT -p udp --dport 5060 -j DROP
  iptables -A INPUT -p udp --dport 5062 -j DROP
  echo "SIP firewall applied — 5060/5062 restricted to $TRUNK"
fi

iptables -S INPUT | grep -E '5060|5062' || true
