# A device went quiet (manager alert)

**Rule:** `device-offline` · tells the venue's manager, **never pages us**.

**What fired.** During opening hours a device (a room tablet, a printer, a reader, the bar computer) sent no heartbeat for two minutes, and `device.offline` went to the manager on duty (M1-16).

**For the manager.** Check the device's power and Wi-Fi, then restart it. Orders from that room still reach the bar through the other screens.

**When it becomes ours.** Only when a money path is at risk: every reader at the venue offline pages us as [readers-offline](readers-offline.md).
