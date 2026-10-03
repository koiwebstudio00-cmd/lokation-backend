FROM postgres:17-alpine

# Inicialización incluida en la imagen: no requiere File Mounts en Dokploy.
COPY init-runtime-role.sh /docker-entrypoint-initdb.d/10-runtime-role.sh
RUN chmod 0644 /docker-entrypoint-initdb.d/10-runtime-role.sh
