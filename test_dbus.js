import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const PlayerIface = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
const loop = GLib.MainLoop.new(null, false);
print("Proxy wrapper created");
loop.quit();
