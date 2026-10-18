//! Open Food Facts barcode lookup.

use std::time::Duration;

use serde_json::Value;

use crate::model::{FoodCategory, FoodInput, GRAMS_MAX, LABEL_MAX, NAME_MAX, Serving, sneaky};
use crate::nutrients::{IU_PER_UG, KJ_PER_KCAL, Nutrients, SALT_PER_SODIUM};

/// Open Food Facts `nutriments` field, the factor converting its
/// grams-per-100 g value into the registry unit, and the registry key.
const OFF_FIELDS: [(&str, f64, &str); 38] = [
    ("energy-kcal", 1.0, "energy"),
    ("caffeine", 1_000.0, "caffeine"),
    ("creatine", 1.0, "creatine"),
    ("vitamin-b12", 1_000_000.0, "b12"),
    ("vitamin-a", 1_000_000.0, "vitamin_a"),
    ("vitamin-c", 1_000.0, "vitamin_c"),
    // Stored in IU: g → µg → IU.
    ("vitamin-d", 1_000_000.0 * IU_PER_UG, "vitamin_d"),
    ("vitamin-e", 1_000.0, "vitamin_e"),
    ("vitamin-k", 1_000_000.0, "vitamin_k"),
    ("vitamin-b1", 1_000.0, "b1"),
    ("vitamin-b2", 1_000.0, "b2"),
    ("vitamin-pp", 1_000.0, "b3"),
    ("pantothenic-acid", 1_000.0, "b5"),
    ("vitamin-b6", 1_000.0, "b6"),
    ("vitamin-b9", 1_000_000.0, "folate"),
    ("selenium", 1_000_000.0, "selenium"),
    ("copper", 1_000.0, "copper"),
    ("manganese", 1_000.0, "manganese"),
    ("calcium", 1_000.0, "calcium"),
    ("iron", 1_000.0, "iron"),
    ("magnesium", 1_000.0, "magnesium"),
    ("phosphorus", 1_000.0, "phosphorus"),
    ("potassium", 1_000.0, "potassium"),
    ("sodium", 1_000.0, "sodium"),
    ("zinc", 1_000.0, "zinc"),
    ("carbohydrates", 1.0, "net_carbs"),
    ("fiber", 1.0, "fiber"),
    ("starch", 1.0, "starch"),
    ("sugars", 1.0, "sugars"),
    ("added-sugars", 1.0, "added_sugars"),
    ("fat", 1.0, "fat"),
    ("cholesterol", 1_000.0, "cholesterol"),
    ("monounsaturated-fat", 1.0, "monounsaturated"),
    ("polyunsaturated-fat", 1.0, "polyunsaturated"),
    ("saturated-fat", 1.0, "saturated"),
    ("trans-fat", 1.0, "trans_fats"),
    ("omega-3-fat", 1.0, "omega_3"),
    ("proteins", 1.0, "protein"),
];

/// Ethanol's density, g/ml: % vol to g per 100 ml.
const ETHANOL_G_PER_ML: f64 = 0.789;

/// Trimmed, non-empty string field without control or bidi characters,
/// cut to `max` characters so it passes the API's validation.
fn truncated_text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s: String = v
        .get(key)?
        .as_str()?
        .chars()
        .filter(|&c| !sneaky(c))
        .collect();
    let s = s.trim();
    (!s.is_empty()).then(|| {
        s.chars()
            .take(max)
            .collect::<String>()
            .trim_end()
            .to_owned()
    })
}

/// OFF reports numbers as JSON numbers or numeric strings, some with a
/// decimal comma ("12,5").
fn number(v: &Value) -> Option<f64> {
    let n = v
        .as_f64()
        .or_else(|| v.as_str()?.trim().replace(',', ".").parse().ok())?;
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// Open Food Facts `categories_tags` → a food category: the first rule
/// with a tag the product has wins. Fruit juice is a sugary drink,
/// never fruit and vegetables; a sweetener-only drink or water is none.
const CATEGORY_RULES: [(&[&str], Option<FoodCategory>); 6] = [
    (&["en:artificially-sweetened-beverages", "en:waters"], None),
    (
        &[
            "en:sodas",
            "en:sweetened-beverages",
            "en:fruit-juices",
            "en:fruit-nectars",
            "en:energy-drinks",
            "en:iced-teas",
        ],
        Some(FoodCategory::SugaryDrinks),
    ),
    (
        &[
            "en:prepared-meats",
            "en:sausages",
            "en:hams",
            "en:bacon",
            "en:salamis",
            "en:cured-meats",
        ],
        Some(FoodCategory::ProcessedMeat),
    ),
    (
        &["en:pizzas", "en:burgers", "en:french-fries"],
        Some(FoodCategory::FastFood),
    ),
    (
        &[
            "en:sweet-snacks",
            "en:confectioneries",
            "en:chocolates",
            "en:candies",
            "en:biscuits-and-cakes",
            "en:salty-snacks",
        ],
        Some(FoodCategory::SweetsSnacks),
    ),
    (
        &["en:fruits", "en:vegetables", "en:berries"],
        Some(FoodCategory::FruitVeg),
    ),
];

/// The category a product's `categories_tags` give, by [`CATEGORY_RULES`].
fn category(product: &Value) -> Option<FoodCategory> {
    let tags: Vec<&str> = product
        .get("categories_tags")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    CATEGORY_RULES
        .iter()
        .find(|(rule, _)| rule.iter().any(|t| tags.contains(t)))
        .and_then(|(_, c)| *c)
}

/// Whether a product is a drink: tagged `en:beverages` (alcoholic and
/// plant-based drinks are under it too).
fn drink(product: &Value) -> bool {
    product
        .get("categories_tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|t| t == "en:beverages"))
}

/// Map an OFF `product` object to a food. `None` if it has no name.
#[must_use]
pub fn map_product(product: &Value, barcode: &str) -> Option<FoodInput> {
    let name = truncated_text(product, "product_name", NAME_MAX)?;
    let nutriments = product.get("nutriments").unwrap_or(&Value::Null);
    let get = |key: &str| nutriments.get(format!("{key}_100g")).and_then(number);

    let mut per100 = Nutrients::default();
    for (field, factor, key) in OFF_FIELDS {
        if let Some(v) = get(field) {
            per100.insert(key, v * factor);
        }
    }
    // OFF's alcohol is % vol, not grams: g/100 ml at ethanol's 0.789 g/ml.
    if let Some(abv) = get("alcohol") {
        per100.insert("alcohol", abv * ETHANOL_G_PER_ML);
    }
    if per100.get("energy").is_none()
        && let Some(kj) = get("energy-kj").or_else(|| get("energy"))
    {
        per100.insert("energy", kj / KJ_PER_KCAL);
    }
    // OFF records labels as printed; EU labels state available carbohydrate
    // (fibre excluded), mapped to `net_carbs`; the total follows on save
    // when fibre is known.
    // ponytail: US-labelled products already state the total, so theirs comes
    // out high by the fibre; fine for an EU user.
    if per100.get("sodium").is_none()
        && let Some(salt) = get("salt")
    {
        per100.insert("sodium", salt / SALT_PER_SODIUM * 1000.0);
    }

    let servings = product
        .get("serving_quantity")
        .and_then(number)
        // A serving the API wouldn't accept is dropped, not the whole product.
        .filter(|g| *g > 0.0 && *g <= GRAMS_MAX)
        .map(|grams| Serving {
            label: truncated_text(product, "serving_size", LABEL_MAX)
                .unwrap_or_else(|| "serving".into()),
            grams,
        })
        .into_iter()
        .collect();

    Some(FoodInput {
        name,
        brand: truncated_text(product, "brands", NAME_MAX),
        barcode: Some(barcode.to_owned()),
        per100,
        servings,
        archived: false,
        category: category(product).map(|c| c.as_str().to_owned()),
        basis: None,
        rev: None,
        uid: None,
        drink: Some(drink(product)),
    })
}

/// Outcome of an Open Food Facts lookup.
#[derive(Debug)]
pub enum Lookup {
    /// OFF has the product; mapped, its per-100 values within the caps, the
    /// rest not yet validated.
    Found(FoodInput),
    /// OFF's product has values no food can have (above the per-100
    /// caps): its data is wrong, so nothing is stored.
    Impossible(String),
    /// OFF answered, but has no usable product for this barcode.
    Missing,
    /// OFF could not be reached or answered garbage; worth retrying.
    Unavailable,
}

/// Fetch a product. Failures are logged.
pub async fn lookup(http: &reqwest::Client, base: &str, barcode: &str) -> Lookup {
    let url = format!(
        "{base}/api/v2/product/{barcode}.json\
         ?fields=product_name,brands,nutriments,serving_quantity,serving_size,categories_tags"
    );
    let res = match http.get(&url).timeout(Duration::from_secs(5)).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => return Lookup::Missing,
        Ok(r) => r.error_for_status(),
        Err(e) => Err(e),
    };
    let body = match res {
        Ok(r) => capped_json(r).await,
        // Its URL names the barcode: never in the journal.
        Err(e) => Err(e.without_url().to_string()),
    };
    match body {
        Ok(body) => match body.get("product").and_then(|p| map_product(p, barcode)) {
            None => Lookup::Missing,
            Some(food) => match food.per100.validate_per100() {
                Ok(()) => Lookup::Found(food),
                Err((n, max)) => {
                    let why = format!("{} over {max} {} per 100 g", n.label, n.unit);
                    tracing::warn!(why, "open food facts product is impossible");
                    Lookup::Impossible(why)
                }
            },
        },
        Err(e) => {
            tracing::warn!(error = %e, "open food facts lookup failed");
            Lookup::Unavailable
        }
    }
}

/// Largest product answer read: a real one is a few kilobytes.
const BODY_MAX: usize = 1024 * 1024;

/// The response as JSON, read up to [`BODY_MAX`] bytes.
async fn capped_json(mut r: reqwest::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| e.without_url().to_string())? {
        if bytes.len() + chunk.len() > BODY_MAX {
            return Err(format!("answer larger than {BODY_MAX} bytes"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_eu_label_carbohydrate_and_units() {
        let p = json!({
            "product_name": "Oat drink",
            "brands": "Oatly",
            "serving_quantity": "250",
            "serving_size": "250 ml",
            "nutriments": {
                "energy-kcal_100g": 46, "proteins_100g": "1.0", "carbohydrates_100g": 6.7,
                "fiber_100g": 0.8, "sodium_100g": 0.04, "vitamin-b12_100g": 0.000_000_38,
                "creatine_100g": 90
            }
        });
        let f = map_product(&p, "7394376616501").unwrap().checked().unwrap();
        assert_eq!(f.name, "Oat drink");
        assert_eq!(f.brand.as_deref(), Some("Oatly"));
        assert_close!(f.per100.get("energy").unwrap(), 46.0);
        assert_close!(f.per100.get("protein").unwrap(), 1.0);
        assert_close!(f.per100.get("sodium").unwrap(), 40.0);
        assert_close!(f.per100.get("b12").unwrap(), 0.38);
        assert_close!(f.per100.get("creatine").unwrap(), 90.0);
        // EU labels give available carbohydrate (fibre excluded).
        assert_close!(f.per100.get("net_carbs").unwrap(), 6.7);
        assert_close!(f.per100.get("carbs").unwrap(), 7.5);
        assert_eq!(
            f.servings,
            vec![Serving {
                label: "250 ml".into(),
                grams: 250.0
            }]
        );
    }

    /// OFF's alcohol (% vol) was dropped, so a beer
    /// got positives, lights and no hydration deduction.
    #[test]
    fn maps_alcohol_by_volume_and_more_vitamins() {
        let p = json!({
            "product_name": "Lager",
            "nutriments": { "alcohol_100g": 4.7, "energy-kcal_100g": 43,
                            "vitamin-d_100g": 0.000_001_5, "vitamin-b9_100g": 0.000_02,
                            "selenium_100g": 0.000_011 }
        });
        let f = map_product(&p, "1").unwrap();
        assert_close!(
            f.per100.get("alcohol").unwrap(),
            3.7083,
            "4.7 % vol × 0.789"
        );
        assert_close!(f.per100.get("vitamin_d").unwrap(), 60.0, "1.5 µg in IU");
        assert_close!(f.per100.get("folate").unwrap(), 20.0);
        assert_close!(f.per100.get("selenium").unwrap(), 11.0);
    }

    #[test]
    fn falls_back_to_kj_and_skips_garbage() {
        let p = json!({
            "product_name": "  Bar ",
            "nutriments": { "energy-kj_100g": 418.4, "fat_100g": "n/a", "sugars_100g": -1 }
        });
        let f = map_product(&p, "1").unwrap();
        assert_eq!(f.name, "Bar");
        assert_close!(f.per100.get("energy").unwrap(), 100.0);
        assert!(f.per100.get("fat").is_none());
        assert!(f.per100.get("sugars").is_none());
        assert!(f.servings.is_empty());
    }

    #[test]
    fn salt_stands_in_for_missing_sodium() {
        let p = json!({ "product_name": "Crisps", "nutriments": { "salt_100g": 1.25, "carbohydrates_100g": 50 } });
        let f = map_product(&p, "1234").unwrap().checked().unwrap();
        assert_close!(f.per100.get("sodium").unwrap(), 500.0);
        assert_eq!(f.per100.get("net_carbs"), Some(50.0));
        assert_eq!(f.per100.get("carbs"), None, "no fibre known: no total");
    }

    #[test]
    fn nameless_product_is_none() {
        assert!(map_product(&json!({ "product_name": "" }), "1").is_none());
        assert!(map_product(&json!({}), "1").is_none());
    }

    #[test]
    fn categories_tags_map() {
        let of = |tags: &[&str]| {
            let p = json!({ "product_name": "X", "categories_tags": tags });
            map_product(&p, "1").unwrap().category
        };
        let cat = |c: FoodCategory| Some(c.as_str().to_owned());
        // Juice is a sugary drink, even though it's made of fruit.
        assert_eq!(
            of(&[
                "en:beverages",
                "en:fruits-based-foods",
                "en:fruit-juices",
                "en:fruits"
            ]),
            cat(FoodCategory::SugaryDrinks)
        );
        // A diet soda is a soda, but has no sugar: none.
        assert_eq!(
            of(&[
                "en:beverages",
                "en:sodas",
                "en:artificially-sweetened-beverages"
            ]),
            None
        );
        assert_eq!(of(&["en:waters", "en:sweetened-beverages"]), None);
        assert_eq!(
            of(&["en:meats", "en:prepared-meats", "en:sausages"]),
            cat(FoodCategory::ProcessedMeat)
        );
        assert_eq!(of(&["en:meals", "en:pizzas"]), cat(FoodCategory::FastFood));
        // Rules go in order: a chocolate-covered berry is a sweet.
        assert_eq!(
            of(&["en:berries", "en:chocolates"]),
            cat(FoodCategory::SweetsSnacks)
        );
        assert_eq!(of(&["en:salty-snacks"]), cat(FoodCategory::SweetsSnacks));
        assert_eq!(of(&["en:vegetables"]), cat(FoodCategory::FruitVeg));
        assert_eq!(of(&["en:dairies", "en:cheeses"]), None);
        assert_eq!(of(&[]), None);
        let untagged = json!({ "product_name": "X", "categories_tags": "en:fruits" });
        assert_eq!(map_product(&untagged, "1").unwrap().category, None);
    }

    #[test]
    fn beverages_are_drinks() {
        let of = |tags: Value| {
            let p = json!({ "product_name": "X", "categories_tags": tags });
            map_product(&p, "1").unwrap().drink
        };
        assert_eq!(of(json!(["en:beverages", "en:waters"])), Some(true));
        assert_eq!(of(json!(["en:dairies", "en:milks"])), Some(false));
        assert_eq!(of(Value::Null), Some(false));
    }

    #[test]
    fn a_decimal_comma_string_is_a_number() {
        let p = json!({
            "product_name": "Rye bread",
            "serving_quantity": "12,5",
            "nutriments": { "fat_100g": " 3,2 " }
        });
        let f = map_product(&p, "1").unwrap();
        assert_close!(f.servings[0].grams, 12.5);
        assert_close!(f.per100.get("fat").unwrap(), 3.2);
    }

    /// Log lines written while `f` runs, as text.
    async fn logged<F: std::future::Future<Output = ()>>(f: F) -> String {
        use std::sync::{Arc, Mutex};
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::default());
        let writer = buf.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);
        f.await;
        drop(guard);
        String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
    }

    #[tokio::test]
    async fn lookups_never_log_the_barcode() {
        // A barcode is what someone ate; the journal outlives the diary.
        const CODE: &str = "6408430000135";
        let http = reqwest::Client::new();
        let unreachable = logged(async {
            let l = lookup(&http, "http://127.0.0.1:9", CODE).await;
            assert!(matches!(l, Lookup::Unavailable), "{l:?}");
        })
        .await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stub = axum::Router::new().fallback(|| async {
            axum::Json(json!({ "product": {
                "product_name": "Salt", "nutriments": { "fat_100g": 500 } } }))
        });
        tokio::spawn(async move { axum::serve(listener, stub).await.unwrap() });
        let impossible = logged(async {
            let l = lookup(&http, &format!("http://{addr}"), CODE).await;
            assert!(matches!(l, Lookup::Impossible(_)), "{l:?}");
        })
        .await;
        for log in [unreachable, impossible] {
            assert!(log.contains("open food facts"), "nothing logged: {log}");
            assert!(!log.contains(CODE), "{log}");
        }
    }
}
