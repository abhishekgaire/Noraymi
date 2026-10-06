-- A drawer per person (M7-07; Money rules 15; Data model · drawer_sessions):
-- a pulled tray keeps a label ("Bar · Maya S.") until it's counted at close.
set lock_timeout = '5s';

grant update (tray_label) on drawer_sessions to app_rw;
