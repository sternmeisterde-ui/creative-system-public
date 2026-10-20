// PostgREST отдаёт максимум 1000 строк за запрос. Для view creative_performance (3000+ крео на
// три канала) и ad_name_mapping это режет хвост молча — агрегаты по параметрам занижаются.
// fetchAll читает страницами до конца; порядок задаёт вызывающий (нужен стабильный ключ).
type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  size = 1000,
): Promise<{ data: T[]; error: string | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: out, error: error.message };
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return { data: out, error: null };
}
