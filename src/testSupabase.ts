import { supabase } from "./supabaseClient";

async function main() {
  // Cambiá "test_table" por una tabla real que tengas en Supabase
  const { data, error } = await supabase
    .from("test_table")
    .insert([{ nombre: "prueba_desde_cursor", creado_en: new Date().toISOString() }])
    .select();

  if (error) {
    console.error("Error al insertar en Supabase:", error);
    return;
  }

  console.log("Insert OK, data devuelta por Supabase:");
  console.log(data);
}

main();
