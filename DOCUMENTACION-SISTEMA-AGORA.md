# Agora — Cómo está armado el sistema y cómo funciona

*Documento de arquitectura en lenguaje simple · Actualizado: 26/07/2026*

---

## 1. Qué es Agora

Agora es un servicio que **convierte facturas en datos**. Un cliente (por ejemplo, una constructora) recibe cientos de facturas de sus proveedores en PDF. En lugar de que una persona las tipee a mano en su sistema contable, las deja en una carpeta — y Agora las lee, entiende qué dice cada una (quién la emitió, qué número tiene, cuánto es el IVA, el total, las percepciones, etc.) y le devuelve esos datos ordenados en una planilla lista para importar en su sistema.

La promesa central: **el cliente arrastra un archivo y recibe datos confiables**, sin tipeo manual y con controles de calidad automáticos.

---

## 2. El viaje de una factura (la historia completa)

Para entender el sistema, lo más fácil es seguir el recorrido de una factura desde que el cliente la suelta hasta que recibe el resultado:

1. **El cliente deja la factura** en su carpeta (o la sube a mano desde la aplicación web).
2. **El vigilante de carpetas** la detecta en menos de un minuto, la toma y la mueve a una subcarpeta "en proceso" — así queda claro qué está pendiente y qué ya se tomó.
3. **La recepción** verifica que el cliente tenga saldo disponible y pone la factura en la **fila de trabajo**.
4. **El motor de procesamiento** la toma de la fila y hace tres cosas: primero **la lee** (convierte la imagen del PDF en texto), después **la interpreta** (una inteligencia artificial identifica cada dato: emisor, número, importes, impuestos), y por último **la controla** (una serie de verificaciones matemáticas y reglas fijas corrigen errores típicos de lectura — por ejemplo, comprueba que neto + IVA + percepciones sume exactamente el total).
5. **El resultado se guarda** en la base de datos y aparece al instante en la aplicación web del cliente, con un semáforo: **Exitoso** (todo cerró), **Con advertencia** (se procesó pero conviene revisar algo — y el sistema dice exactamente qué), o **Fallido** (no se pudo procesar, con el motivo).
6. **La factura original se archiva** en la carpeta "procesados" (o "fallidos" si no anduvo), y **los datos extraídos se depositan** como planilla (CSV o Excel) en la carpeta "extracciones" del cliente.
7. **Se descuenta el costo** del saldo del cliente (un precio por documento, configurable).

Si algo sale mal por un problema momentáneo (internet, un servicio externo caído unos segundos), el sistema **reintenta solo hasta 3 veces** antes de dar el documento por fallido. Y si el usuario corrige un dato a mano, esa corrección **queda anotada para que el sistema aprenda** (ver sección 6).

---

## 3. Las partes del sistema

### 3.1 La aplicación web (lo que ve el cliente)
Vive en **app.agoradigital.io**. Es la cara del sistema: ahí el cliente ve su tablero con métricas (cuántos documentos procesó, efectividad, costo por documento), la lista de sus procesos y documentos, puede **buscar y filtrar** (por fecha, cliente, con calendarios en español), **editar y aprobar** documentos con advertencia, exportar a Excel, configurar sus integraciones y cargar saldo. Cada cliente **ve solamente lo suyo**: la separación entre organizaciones está garantizada a nivel de base de datos, no es solo cosmética.

### 3.2 La recepción (la puerta de entrada)
Vive en **api.agoradigital.io**. Es la ventanilla por donde entra todo pedido de trabajo: recibe la factura (de la web o de los vigilantes de carpetas), controla el saldo, registra el proceso y lo pone en la fila. También atiende otros trámites: los avisos de pago de MercadoPago, la conexión con Google Drive, y las consultas de salud del sistema.

### 3.3 La fila de trabajo (la cola)
Una fila ordenada donde esperan los documentos a procesar. Garantiza que nada se pierda ni se procese dos veces, que se trabajen de a varios en paralelo (hoy, tres a la vez) y que ante una falla momentánea el trabajo **se reintente automáticamente** con esperas crecientes (5, 10, 20 segundos). Está montada sobre un servicio de memoria rápida (Redis) configurado para no descartar nada.

### 3.4 El motor de procesamiento (el corazón)
Es el que hace el trabajo pesado, en tres etapas:

- **El lector (OCR)**: un servicio especializado (Mistral) que convierte la imagen del PDF en texto. Es como unos ojos muy buenos, pero a veces pierde detalles gráficos — por ejemplo, la letra grande "A" o "B" dibujada en el recuadro de la factura.
- **El analista (IA)**: una inteligencia artificial (de OpenAI) que lee ese texto y lo interpreta como lo haría un analista contable: identifica emisor y receptor, tipo de comprobante, fechas, todos los importes, el CAE, las órdenes de compra y hasta el detalle de renglones (producto, cantidad, precio). Trabaja con instrucciones muy afinadas que fuimos puliendo con casos reales.
- **Los controles de calidad (reglas fijas)**: acá está gran parte del valor. Después de la IA, una serie de verificaciones **matemáticas y determinísticas** corrigen los errores típicos: el número de comprobante y el punto de venta se toman de **lo que está impreso** en la factura (no de lo que la IA "cree"); si hay descuento y la cuenta no cierra, el neto se recalcula por identidad (total − IVA − percepciones); si las percepciones vienen en varias líneas por provincia, se verifica la suma; y todo importe pasa por el control de que la suma cierre exacta contra el total. La IA propone; las matemáticas confirman.

Además, para clientes habilitados, hay un paso extra de **visión**: la IA mira la *imagen* de la primera página (no solo el texto) para leer la letra del comprobante que el lector de texto pierde — y solo puede corregir el tipo de documento, nunca los importes.

### 3.5 La base de datos (la memoria del sistema)
Un servicio en la nube (Supabase) que guarda todo: organizaciones y usuarios, procesos y documentos con todos sus datos extraídos, saldos y movimientos de crédito, precios y configuraciones, el catálogo oficial de tipos de comprobante (97 códigos de AFIP), y las tablas del sistema de aprendizaje. Dos características clave: **cada dato pertenece a una organización** y las reglas de acceso lo hacen invisible para las demás; y **la clasificación de cada documento (exitoso/advertencia/fallido, con su motivo) se calcula automáticamente** cada vez que un dato cambia, siempre con el mismo criterio.

### 3.6 Las integraciones (las carpetas vigiladas)
Es la forma cómoda de trabajar: el cliente no sube archivos a mano, sino que conecta una carpeta suya (en Google Drive, o en almacenamientos como Supabase/Firebase). El sistema la **vigila a intervalos regulares** (configurable, típicamente cada minuto) y mantiene una estructura fija de subcarpetas: lo nuevo se toma de la raíz, pasa a **en_proceso**, termina en **procesados** o **fallidos**, y los resultados se depositan en **extracciones**. Los archivos procesados de a uno se **renombran con sus datos** (CUIT + número + código AFIP) para que la carpeta quede ordenada y buscable. Si el mismo comprobante se sube dos veces, el sistema lo detecta como **duplicado**: lo procesa y lo marca, pero **no genera la planilla de salida** de nuevo, para no duplicar registros en el sistema del cliente.

### 3.7 El cobro (créditos y precios)
El cliente carga **saldo en dólares** (por MercadoPago) y cada documento procesado descuenta un precio que se compone de: un **precio base** + extras por las **funciones activas** (qué integración usa, si pide el Excel acumulativo, el detalle de productos, la frecuencia de vigilancia de la carpeta). Todos los precios son **configurables desde el panel de administración, sin tocar código**. Sin saldo, no se procesa (y el sistema lo avisa claramente).

### 3.8 El sistema que aprende (el círculo de mejora)
Es la pieza más nueva y la que hace que Agora mejore con el uso, en tres engranajes:

- **El cuaderno de correcciones**: cada vez que un usuario corrige a mano un dato que la IA leyó mal, el sistema anota en silencio el par *"la IA dijo X → el humano corrigió Y"*. Nadie tiene que hacer nada; se anota solo.
- **Las fichas por proveedor**: cada proveedor imprime sus facturas siempre igual — y siempre con las mismas "mañas". Una ficha describe, en español simple, cómo leer a ese proveedor (ej.: *"este imprime las percepciones en varias líneas por provincia: hay que sumarlas"*). Cuando llega una factura, el sistema reconoce al proveedor por su CUIT y le pasa su ficha al analista. Resultado: un error se corrige **una sola vez** y queda aprendido para siempre, para todos los clientes.
- **El visor en el panel de administración**: muestra qué campos se corrigen más y qué proveedores generan más correcciones, e indica cuáles todavía no tienen ficha. Desde ahí mismo se crea o edita la ficha — sin programar, sin desplegar nada, con efecto en minutos.

El círculo completo: *el cliente corrige → el cuaderno anota → el visor muestra el patrón → se escribe la ficha → la IA deja de equivocarse en eso*.

### 3.9 La vigilancia (el panel de Monitoreo)
Un panel exclusivo del administrador general que ve **todo el sistema, todas las organizaciones**: cuántos procesos y documentos hubo (con filtros por cliente, fecha y estado, paginación y exportación a Excel), los errores recientes, si hay trabajos trabados o cola acumulada (con semáforo de alerta a simple vista), la salud del motor, los saldos de cada cliente con su actividad mensual, la administración de precios y tipos de comprobante, y el sistema de aprendizaje (sección 3.8). Está organizado en pocas tarjetas que agrupan todo por tema.

---

## 4. Cómo se conectan las partes (el mapa)

```
  CLIENTE                          SISTEMA AGORA                       SERVICIOS EXTERNOS
  ─────────                        ─────────────                       ──────────────────
  Carpeta vigilada ──┐
  (Drive/Storage)    │
                     ├──► Recepción ──► Fila de ──► Motor ──┬──► Lector de imagen (Mistral)
  Aplicación web ────┘    (saldo,       trabajo     (3 a    ├──► Analista IA (OpenAI)
  (subida manual)         registro)    (reintentos)  la vez) └──► Controles matemáticos + fichas
                                                        │
                                                        ▼
                                                  Base de datos ◄──── Aplicación web
                                                  (documentos,        (el cliente ve y
                                                   saldos, fichas,     corrige al instante)
                                                   cuaderno)
                                                        │
                     ◄──────────────────────────────────┘
  Carpeta del cliente: original archivado + planilla de resultados

  Pagos: MercadoPago ──► Recepción ──► suma saldo
  Administración: panel de Monitoreo ──► ve y gestiona TODO
```

---

## 5. Dónde vive cada cosa

Todo el sistema corre en **un servidor propio en la nube** más **dos servicios administrados**:

- En el **servidor** conviven la aplicación web (servida al público), la recepción, la fila de trabajo y el motor de procesamiento (estos dos últimos, empaquetados en contenedores que se reinician y actualizan de forma controlada).
- La **base de datos** es un servicio administrado aparte (Supabase), con respaldo y reglas de acceso propias.
- La **memoria rápida de la fila** (Redis) es otro servicio administrado, configurado para nunca descartar trabajos.
- Los dominios: **agoradigital.io** (página de presentación), **app.agoradigital.io** (la aplicación) y **api.agoradigital.io** (la recepción).

---

## 6. Cómo se trabaja sobre el sistema (el equipo y el método)

El sistema está **en producción con clientes reales**, así que todo cambio sigue una disciplina estricta con tres roles:

- **El director (Sergio)** decide qué se hace, da el visto bueno a los cambios sensibles, valida los resultados en pantalla y con documentos reales, y es el contacto con los clientes.
- **El asistente de arquitectura (Cowork)** analiza los problemas con datos (nunca de memoria), propone la solución, escribe el código y los cambios de base de datos, los verifica localmente y documenta todo (bitácora del proyecto y tablero de tareas en Notion).
- **El operador de despliegue (Claude Code)** ejecuta los pasos que tocan el servidor: subir archivos, reconstruir los contenedores, publicar la web y registrar los cambios en el historial del código. Trabaja con instrucciones exactas y verifica con "huellas digitales" (md5) que lo que llega al servidor sea byte a byte lo que se probó.

Las reglas de oro del método: los cambios se hacen **de a uno y quirúrgicos** (mejorar sin romper lo que anda); todo cambio sensible se **propone y espera aprobación**; nada se da por bueno hasta **validarlo con un documento real** comparando los datos en la base; y recién entonces se registra como definitivo. Las zonas críticas (login, cobros, conexión con Drive, el corazón del procesamiento) están marcadas como **"zonas cerradas"**: no se tocan sin tarea explícita.

---

## 7. Glosario mínimo

- **Proceso (job)**: una tanda de trabajo; puede ser un archivo o un ZIP con varios.
- **Documento**: cada factura/nota individual con sus datos extraídos.
- **OCR**: la "lectura" que convierte la imagen del PDF en texto.
- **Advertencia**: el documento se procesó, pero algo merece revisión humana — el sistema siempre dice qué (ej.: "el total no cierra", "tiene descuento, revisá los importes").
- **Duplicado**: mismo comprobante (mismo CUIT + número) procesado más de una vez; se marca y no genera salida repetida.
- **Ficha de proveedor**: instrucciones de lectura específicas de un emisor, aprendidas de errores reales.
- **Cuaderno de correcciones**: el registro automático de todo lo que los humanos corrigen; la materia prima del aprendizaje.
- **Tenant / organización**: cada empresa cliente, con sus datos completamente separados de las demás.
