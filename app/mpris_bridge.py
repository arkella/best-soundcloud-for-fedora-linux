#!/usr/bin/env python3
import json
import os
import sys
import urllib.request

try:
    import gi
    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gio, GLib
except Exception:
    sys.exit(0)

STATE_FILE = "/tmp/soundcloud-electron-state.json"
API_BASE = "http://127.0.0.1:43821"

MPRIS_XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>
"""


def send_action(action):
    try:
        urllib.request.urlopen(f"{API_BASE}/action/{action}", timeout=0.8).read()
    except Exception:
        pass


def read_state():
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {
        "title": "SoundCloud",
        "artist": "",
        "artworkUrl": "",
        "isPlaying": False,
        "isRepeat": False,
        "repeatMode": "none",
        "isShuffle": False,
    }


class MprisServer:
    def __init__(self):
        self.node_info = Gio.DBusNodeInfo.new_for_xml(MPRIS_XML)
        self.conn = None
        self.last_snapshot = None
        self.owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            "org.mpris.MediaPlayer2.soundcloud",
            Gio.BusNameOwnerFlags.NONE,
            self.on_bus_acquired,
            None,
            None,
        )

    def on_bus_acquired(self, connection, _name):
        self.conn = connection
        for iface in self.node_info.interfaces:
            connection.register_object(
                "/org/mpris/MediaPlayer2",
                iface,
                self.handle_method_call,
                self.handle_get_property,
                self.handle_set_property,
            )
        GLib.timeout_add(700, self.poll_state)

    def build_metadata(self, st):
        meta = {
            "mpris:trackid": GLib.Variant("o", "/org/mpris/MediaPlayer2/Track/1"),
            "xesam:title": GLib.Variant("s", st.get("title") or "SoundCloud"),
            "xesam:artist": GLib.Variant("as", [st.get("artist") or "SoundCloud"]),
        }
        if st.get("artworkUrl"):
            meta["mpris:artUrl"] = GLib.Variant("s", st["artworkUrl"])
        return GLib.Variant("a{sv}", meta)

    def get_loop_status(self, st):
        rm = st.get("repeatMode", "none")
        if rm == "one":
            return "Track"
        if rm == "all" or st.get("isRepeat"):
            return "Playlist"
        return "None"

    def handle_method_call(self, _conn, _sender, _path, iface_name, method_name, _params, invocation):
        if iface_name == "org.mpris.MediaPlayer2":
            if method_name == "Raise":
                send_action("focus")
            elif method_name == "Quit":
                send_action("quit")
        elif iface_name == "org.mpris.MediaPlayer2.Player":
            if method_name in ("PlayPause", "Play", "Pause"):
                send_action("playpause")
            elif method_name == "Next":
                send_action("next")
            elif method_name == "Previous":
                send_action("prev")
            elif method_name == "Stop":
                send_action("playpause")
        invocation.return_value(None)

    def handle_get_property(self, _conn, _sender, _path, iface_name, prop_name):
        st = read_state()
        if iface_name == "org.mpris.MediaPlayer2":
            props = {
                "CanQuit": GLib.Variant("b", True),
                "CanRaise": GLib.Variant("b", True),
                "HasTrackList": GLib.Variant("b", False),
                "Identity": GLib.Variant("s", "SoundCloud"),
                "DesktopEntry": GLib.Variant("s", "soundcloud-electron"),
                "SupportedUriSchemes": GLib.Variant("as", ["https"]),
                "SupportedMimeTypes": GLib.Variant("as", ["audio/mpeg"]),
            }
            return props.get(prop_name)
        elif iface_name == "org.mpris.MediaPlayer2.Player":
            if prop_name == "PlaybackStatus":
                return GLib.Variant("s", "Playing" if st.get("isPlaying") else "Paused")
            if prop_name == "LoopStatus":
                return GLib.Variant("s", self.get_loop_status(st))
            if prop_name == "Shuffle":
                return GLib.Variant("b", bool(st.get("isShuffle")))
            if prop_name == "Metadata":
                return self.build_metadata(st)
            if prop_name == "Volume":
                return GLib.Variant("d", 1.0)
            if prop_name in ("CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanControl"):
                return GLib.Variant("b", True)
            if prop_name == "CanSeek":
                return GLib.Variant("b", False)
        return None

    def handle_set_property(self, _conn, _sender, _path, iface_name, prop_name, _value):
        if iface_name == "org.mpris.MediaPlayer2.Player":
            if prop_name == "LoopStatus":
                send_action("repeat")
                return True
            if prop_name == "Shuffle":
                send_action("shuffle")
                return True
        return True

    def poll_state(self):
        if not self.conn:
            return True
        st = read_state()
        snap = (
            st.get("title"),
            st.get("artist"),
            st.get("artworkUrl"),
            st.get("isPlaying"),
            st.get("repeatMode"),
            st.get("isRepeat"),
        )
        if snap != self.last_snapshot:
            self.last_snapshot = snap
            changed = {
                "PlaybackStatus": GLib.Variant("s", "Playing" if st.get("isPlaying") else "Paused"),
                "LoopStatus": GLib.Variant("s", self.get_loop_status(st)),
                "Metadata": self.build_metadata(st),
            }
            try:
                self.conn.emit_signal(
                    None,
                    "/org/mpris/MediaPlayer2",
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    GLib.Variant(
                        "(sa{sv}as)",
                        ("org.mpris.MediaPlayer2.Player", changed, []),
                    ),
                )
            except Exception:
                pass
        return True


if __name__ == "__main__":
    server = MprisServer()
    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
