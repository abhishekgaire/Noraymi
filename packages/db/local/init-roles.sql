-- Local development only (docker-compose.yml mounts this into Postgres's
-- first-start folder). Creates the app role with a login so the API can
-- connect as app_rw; migration 0002 sets everything else about it.
create role app_rw login password 'app_rw' nobypassrls noinherit;
