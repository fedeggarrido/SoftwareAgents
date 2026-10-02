# SA-003: autorización manual del piloto de compañía

El runtime solo ejecuta el argv autorizado por el operador en `~/.pixel-agents/config.json`, bajo `companyAutopilot[<ruta absoluta del workspace>]`. La oficina no puede crear ni modificar esta autorización. Al activar el piloto, si `board.json` conserva `autopilot.command`, debe coincidir exactamente (binario, argumentos, orden y longitud); cualquier diferencia produce un `companyNotice` y no escribe el estado ni arranca el supervisor. Si el board omite `command`, se usa directamente el autorizado. Pausar no requiere autorización del operador ni coincidencia del comando: solo escribe el estado contenido y nunca lanza procesos. La URL con token sigue siendo obligatoria para activar o pausar el piloto.

Para configurar la oficina, el operador debe realizar una sola vez estos pasos, sin modificar su repositorio:

1. Revisar el `autopilot.command` actual de `docs/backlog/board.json` y confirmar cada argumento. No autorizar automáticamente contenido del workspace.
2. Editar **su** `~/.pixel-agents/config.json`, conservando los demás campos, y añadir una entrada como esta (las rutas y el argv son ejemplos, sustituirlos por los revisados):

   ```json
   {
     "companyAutopilot": {
       "D:\\Source\\MyProject": {
         "command": ["C:\\ruta\\python.exe", "C:\\ruta\\supervisor.py", "--interval", "20"],
         "stateFile": "autopilot-state.json"
       }
     }
   }
   ```

3. La clave debe ser el workspace absoluto que usa la oficina, no un identificador escapado de Claude ni necesariamente el repositorio principal si la oficina abre un worktree. Cada workspace necesita autorización propia; en Windows las claves no distinguen mayúsculas, y en POSIX conservan su capitalización. Preferir rutas absolutas para el ejecutable y el supervisor: autorizar un argv no protege el contenido de un script editable por agentes ni la resolución de un binario desde `PATH`.
4. `stateFile` es opcional: si se omite, se mantiene el del board; si se configura, prevalece sobre él. Es relativo al `git-common-dir`. `decisionsFile` sigue siendo relativo al workspace. Ninguna ruta puede ser absoluta ni contener segmentos `..` (se reconocen separadores Windows y POSIX). El directorio contenedor del estado debe existir, como antes.
5. Abrir la oficina mediante su URL con token y activar el piloto. No hace falta reiniciar: la autorización se lee en cada operación. Para revocarla, eliminar la entrada; esto impide activar el piloto, pero permite pausarlo desde la oficina y no termina un supervisor ya lanzado.

### Permisos de la configuración

En POSIX, cada escritura atómica usa `0600`, también si existe un temporal anterior; tras una edición manual, ejecutar `chmod 600 ~/.pixel-agents/config.json`. La prueba de modo se ejecuta en POSIX y se omite en Windows.

En Windows, `0600` no establece una DACL. El operador debe comprobar **el archivo y su directorio**, porque los temporales heredan los permisos del directorio:

```powershell
Get-Acl "$env:USERPROFILE\.pixel-agents" | Format-List Owner,AccessToString
Get-Acl "$env:USERPROFILE\.pixel-agents\config.json" | Format-List Owner,AccessToString
```

En Propiedades → Seguridad → Opciones avanzadas de ambos, deshabilitar la herencia y dejar únicamente al usuario operador si se requiere acceso exclusivamente suyo; revisar también los grupos a los que pertenece. SYSTEM y Administradores conservan capacidad de intervención administrativa si se mantienen en la ACL. No basta con comprobar el propietario. Revisar de nuevo el archivo después de guardar preferencias, ya que se sustituye por un temporal.

La contención de SA-003 es léxica. Enlaces simbólicos, junctions, condiciones de carrera y el endurecimiento de escrituras se abordan en SA-060; no forman una garantía de contención física en esta entrega.
