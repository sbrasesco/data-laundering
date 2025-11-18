import { supabase } from "./supabaseClient";

async function checkSchema() {
  console.log("Verificando si las tablas existen en la base de datos...\n");

  const tables = ["organizations", "profiles", "pdf_jobs"];

  for (const tableName of tables) {
    try {
      // Intentar hacer un select limitado para verificar si la tabla existe
      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .limit(0);

      if (error) {
        if (error.code === "PGRST205" || error.message.includes("Could not find the table")) {
          console.log(`❌ Tabla "${tableName}" NO existe`);
        } else {
          console.log(`⚠️  Tabla "${tableName}" existe pero hay un error:`, error.message);
        }
      } else {
        console.log(`✅ Tabla "${tableName}" existe`);
      }
    } catch (err: any) {
      console.log(`❌ Error al verificar "${tableName}":`, err.message);
    }
  }

  console.log("\n--- Verificación completada ---");
}

checkSchema();

