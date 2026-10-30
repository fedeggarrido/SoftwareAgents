# ADR-0005: conservar temporalmente el query del token

Estado: aceptado para SA-075.

La URL local y el handshake standalone conservan `?token=` por compatibilidad.
Un fragmento no se transmite en HTTP, pero tampoco autentica el upgrade WS:
requiere un protocolo de primer mensaje (con estado, timeout y gating de todos
los mensajes) o un subprotocolo con credenciales (que también hay que redactar en
cabeceras). No es un cambio trivial del transporte actual y sus reconexiones.
VS Code usa Bearer y no necesita la URL.

SA-075 redacta las peticiones HTTP y upgrades, elimina el log del tipo de mensaje
WS controlado por el cliente y permite revocar el token cerrando los sockets.
El token sigue siendo un secreto en terminal, historial y discovery. Antes de
exponer remotamente, migrar la SPA a fragmento con autenticación WS explícita,
limpiar el fragmento del historial y mantener un periodo de compatibilidad query.
