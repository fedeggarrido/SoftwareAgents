# Revisión de diseño profesional (2026-11-09)

Revisión de la oficina standalone con criterios de diseño de interfaz de juego pixel art y de paneles de monitorización en tiempo real.

- **Capturas:** oficina con datos reales, escritorio a 1440×900 y móvil a 375×812.
- **Criterios aplicados:**
  - probar a tamaño real con escalado entero;
  - legibilidad del texto, con un mínimo de unos 14 px de lectura;
  - contraste WCAG AA de 4.5:1;
  - el estado nunca se comunica solo con color;
  - resumen primero y detalle bajo demanda (_progressive disclosure_);
  - la «prueba de los 5 segundos» para entender el estado;
  - diseño minimalista según Nielsen;
  - anclar el HUD a esquinas y bordes.

## Veredicto

La oficina pixel art tiene encanto y una identidad clara. La capa de gestión (paneles, barra, ventanas), en cambio, no está a la altura:

- usa una tipografía decorativa a un tamaño ilegible para leer textos largos;
- la jerarquía es plana;
- a menudo enseña datos de sistema en vez de respuestas para el usuario.

Hoy no pasa la prueba de los 5 segundos: al abrir la oficina no se sabe qué está pasando ni si el usuario tiene que hacer algo.

## Hallazgos, por impacto

### D1 — Tipografía (crítico)

- La fuente pixel decorativa se usa para todo, incluidos párrafos y listas, a unos 8 px. Es buena para títulos y etiquetas cortas, pero mala para leer.
- **Propuesta:** un sistema de dos fuentes.
  - **Pixel** (la actual) en títulos, botones y números grandes del HUD, a escala entera (16/24/32 px).
  - **Fuente de lectura** sin serifa y nítida (por ejemplo, la del sistema) para cuerpo de texto, listas y detalles, a 14–16 px con interlineado de 1.4.
- Mínimo absoluto: 12 px solo en metadatos. Añadir en Ajustes «Tamaño del texto: Normal / Grande».

### D2 — Jerarquía y prueba de los 5 segundos (crítico)

- Arriba solo aparece «15 de 20 hechas». Nada dice qué hace cada agente ni si el usuario tiene algo pendiente.
- **Propuesta:** una franja de estado en la parte superior con tres cifras:
  - **Trabajando:** N agentes;
  - **Te necesitan:** N decisiones o revisiones (resaltado y pulsable);
  - **Bloqueado:** N tareas.
- Lo que requiere atención humana siempre va primero y es un botón. El progreso queda en segundo plano.

### D3 — Estado solo con color y texto crudo (alto)

- Hay estados en mayúsculas de sistema (`WAITING_HUMAN → REVIEW`) y puntos de color sin icono.
- **Propuesta:** etiquetas de estado («chips») con **icono, texto en español y color**, a partir de un único mapa de estados. Por ejemplo, «⏳ Esperando tu revisión», «▶ En curso», «⛔ Bloqueada», «✓ Hecha». Así se lee también con daltonismo.

### D4 — Densidad y ruido (alto)

- **Backlog:**
  - el id aparece repetido;
  - hay UUIDs;
  - hay dos «solo lectura»;
  - el enlace a ClickUp aparece como primera acción;
  - todas las líneas tienen el mismo peso.
- **Propuesta para el Backlog:**
  - tarjetas con **título humano** en grande y una sola línea de metadatos (id corto · estado · antigüedad);
  - el detalle técnico queda plegado, en SA-143;
  - el modo de solo lectura se indica una sola vez, en el distintivo de la esquina.
- **Agrupación:** los grupos quedan así, cada uno con cabecera fija:
  - **Te necesitan**;
  - **En curso**;
  - **Pendientes**;
  - **Hechas**, plegado por defecto.

### D5 — Lenguaje (alto)

- La interfaz mezcla inglés y español: Settings, Layout, el tour y las opciones.
- Hay jerga interna: «decisiones estructuradas», «legacy», «manager», «Project», «WorkStore», «Executor».
- **Propuesta:** un glosario de interfaz en español con voz directa («tú») y verbos de acción. Los términos internos solo aparecen en «Detalles».

### D6 — Diseño y espacio (medio)

- La ventana de paneles se abre tapando el centro de la oficina.
- La oficina queda pequeña en el centro con mucho vacío alrededor.
- En móvil, las etiquetas de la barra se parten a mitad de palabra.
- **Propuesta:**
  - En escritorio la ventana se acopla a la derecha como panel lateral redimensionable, y la oficina ocupa el resto con zoom entero automático.
  - En móvil, la barra pasa a 4 iconos con etiqueta (Oficina, Trabajo, Decisiones, Más) y los paneles se abren como hoja inferior.

### D7 — Estados vacíos y primera vez (medio)

- Reuniones y Decisiones vacías no enseñan nada.
- **Propuesta:** cada estado vacío explica qué es, cuándo aparecerá algo y qué acción adelanta ese momento.
  - Ejemplo para Decisiones: «Cuando un agente necesite que elijas algo, aparecerá aquí y te avisaremos.»

### D8 — Movimiento y feedback (medio)

- En tiempo real, las actualizaciones deben ser sutiles.
- **Propuesta:**
  - contadores que cambian con un breve destello;
  - avisos apilados con una duración clara;
  - nada de animaciones constantes en los paneles;
  - respetar `prefers-reduced-motion`.

### D9 — Coherencia del sistema visual (medio)

- Botones, chips y bordes tienen grosores y paddings distintos según el panel.
- **Propuesta:**
  - tokens únicos en `index.css`: escala de espacios 4/8/12/16/24, un radio y dos grosores de borde;
  - 3 variantes de botón: primario, secundario y fantasma;
  - un componente `StatusChip` compartido;
  - marcos de panel con estética pixel (nine-slice), aplicados igual en todas partes.

## Guardas automáticas propuestas (e2e de diseño)

Para que esto no vuelva a romperse, se proponen pruebas Playwright que recorren todas las pantallas en escritorio y en móvil, y comprueban:

1. ningún texto de lectura por debajo de 12 px, y el cuerpo de texto a 14 px o más;
2. contraste AA en todo texto visible, sumado a lo que ya hace designCapture;
3. ninguna etiqueta partida a mitad de palabra y ningún desbordamiento horizontal;
4. que no hay cadenas en inglés ni términos internos en la interfaz en español (lista de términos prohibidos);
5. ningún UUID ni estado en mayúsculas de sistema visible;
6. que los paneles no tapan el HUD ni la barra, y que los objetivos táctiles miden al menos 44 px en móvil;
7. capturas de referencia por pantalla, comparadas con una tolerancia, que se adjuntan al informe.

## Orden recomendado

- **Ahora:** D1, D3, D5 y las guardas e2e, porque son base para todo lo demás.
- **Después:** D2 y D4, junto con SA-143, SA-145 y SA-148.
- **Más adelante:** D6 y D7, junto con SA-147.

## Fuentes consultadas

- [Pixel art UI readability: color and contrast rules (DEV)](https://dev.to/gamineai/pixel-art-ui-readability-in-2026-color-and-contrast-rules-that-prevent-store-screenshot-rejection-2d5f)
- [Indie game UI tips](https://image-to-pixel-art-com.pages.dev/guides/indie-game-ui-tips)
- [Game UI & HUD pixel art (Wayline)](https://www.wayline.io/learn/game-ui-art/0)
- [Best pixel fonts for pixel art game assets](https://pixeltype-f1.pages.dev/best-pixel-fonts-for-pixel-art-game-assets-game-development-fonts)
- [How to make pixel art that reads clearly (Bugnet)](https://bugnet.io/blog/how-to-make-pixel-art-that-reads-clearly)
- [UX strategies for real-time dashboards (Smashing Magazine)](https://smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/)
- [Dashboard design principles 2026 (DesignRush)](https://www.designrush.com/agency/ui-ux-design/trends/dashboard-design-principles)
- [Dashboard UX design (Tenet)](https://www.wearetenet.com/blog/dashboard-ux-design)
