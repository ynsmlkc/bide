//! Bide treasury — reklamveren yatirmalarinin zincir ustu kaydi.
//!
//! Bu kontrat Bide'in odeme hesabinin (sicak cuzdan) KENDISINE deploy edilir.
//! Reklamveren USDC'yi `ft_transfer_call` ile bu hesaba gonderir; USDC
//! kontrati `ft_on_transfer`'i cagirir ve kontrat yatirmayi sirali bir
//! kayda yazar. Para hesabin kendi USDC bakiyesinde kalir — yayincilara
//! yapilan odemeler ayni hesaptan cikar.
//!
//! Neden boyle:
//!
//!   * **Eslesme kendiliginden.** "Bu para kimin?" sorusunun cevabi
//!     `sender_id`; memo yok, kullanicinin yazmayi unutacagi bir alan yok.
//!   * **Indexer gerekmiyor.** Sunucu `deposits_from(cursor)` ile kaydi
//!     okur; kayit indeksi zaten bir imlec. Ucuncu taraf bir API'ye ya da
//!     blok tarayiciya bagimlilik yok.
//!   * **Dogrulanabilir.** Herkes `total_deposited(account)` ile bir
//!     reklamverenin toplam ne yatirdigini zincirde gorebilir, Bide'in
//!     veritabanina guvenmeden.
//!   * **Yanlis token geri doner.** Baska bir NEP-141 kontrati bu metodu
//!     cagirirsa kontrat panikler; NEP-141 `ft_resolve_transfer` parayi
//!     gondericiye iade eder.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Deposits,
    Totals,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Deposit {
    pub sender: AccountId,
    pub amount: u128,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct DepositView {
    pub index: u64,
    pub sender: AccountId,
    pub amount: U128,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

/// `deposits_from` tek cagrida en fazla bu kadar kayit dondurur — view
/// cagrisinin gaz siniri asilmasin.
pub const MAX_PAGE: u64 = 100;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    /// Kabul edilen tek NEP-141 kontrati (USDC).
    token: AccountId,
    deposits: Vector<Deposit>,
    totals: LookupMap<AccountId, u128>,
}

#[near]
impl Treasury {
    /// Bir kez, deploy aninda. Yalnizca hesabin kendisi cagirabilir —
    /// baskasi kontrati yanlis token'la baslatamaz.
    #[init]
    pub fn new(token: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the treasury account can initialize"
        );
        Self {
            token,
            deposits: Vector::new(StorageKey::Deposits),
            totals: LookupMap::new(StorageKey::Totals),
        }
    }

    /// NEP-141 alici kancasi. Yalnizca USDC kontrati cagirabilir.
    ///
    /// `0` dondurur: gelen tutarin tamami kabul edildi, iade yok.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        // Panik = NEP-141 parayi gondericiye iade eder. Yanlis token'la
        // yapilan yatirma kaybolmaz, geri doner.
        require!(env::predecessor_account_id() == self.token, "only USDC is accepted");
        require!(amount.0 > 0, "amount must be positive");
        let _ = msg;

        let index = self.deposits.len() as u64;
        let d = Deposit {
            sender: sender_id.clone(),
            amount: amount.0,
            block_height: env::block_height(),
            timestamp_ms: env::block_timestamp_ms(),
        };
        self.deposits.push(d);

        let total = self.totals.get(&sender_id).copied().unwrap_or(0);
        self.totals.insert(sender_id.clone(), total.checked_add(amount.0).expect("overflow"));

        // NEP-297 olayi — gezginler ve indexer'lar okuyabilsin.
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"bide","version":"1.0.0","event":"deposit","data":[{{"index":{},"sender":"{}","amount":"{}"}}]}}"#,
            index, sender_id, amount.0
        ));

        PromiseOrValue::Value(U128(0))
    }

    /// `from_index`'ten itibaren en fazla `limit` (≤ `MAX_PAGE`) kayit.
    /// Sunucu bunu imlec olarak kullanir: son okunan indeks + 1.
    pub fn deposits_from(&self, from_index: u64, limit: u64) -> Vec<DepositView> {
        let len = self.deposits.len() as u64;
        let end = from_index.saturating_add(limit.min(MAX_PAGE)).min(len);
        (from_index..end)
            .map(|i| {
                let d = &self.deposits[i as u32];
                DepositView {
                    index: i,
                    sender: d.sender.clone(),
                    amount: U128(d.amount),
                    block_height: d.block_height,
                    timestamp_ms: d.timestamp_ms,
                }
            })
            .collect()
    }

    pub fn deposit_count(&self) -> u64 {
        self.deposits.len() as u64
    }

    /// Bir reklamverenin bugune kadar yatirdigi toplam (micro USDC).
    pub fn total_deposited(&self, account_id: AccountId) -> U128 {
        U128(self.totals.get(&account_id).copied().unwrap_or(0))
    }

    pub fn token(&self) -> AccountId {
        self.token.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    const TREASURY: &str = "bide-treasury.testnet";
    const USDC: &str = "usdc.testnet";

    fn ctx(predecessor: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(TREASURY))
            .predecessor_account_id(acc(predecessor))
            .block_height(42)
            .block_timestamp(1_700_000_000_000_000_000);
        testing_env!(b.build());
    }

    fn setup() -> Treasury {
        ctx(TREASURY);
        let t = Treasury::new(acc(USDC));
        ctx(USDC);
        t
    }

    #[test]
    fn records_deposit_in_order() {
        let mut t = setup();
        let r = t.ft_on_transfer(acc("alice.testnet"), U128(5_000_000), String::new());
        assert!(matches!(r, PromiseOrValue::Value(U128(0))));
        t.ft_on_transfer(acc("bob.testnet"), U128(1), String::new());
        t.ft_on_transfer(acc("alice.testnet"), U128(2_000_000), String::new());

        assert_eq!(t.deposit_count(), 3);
        let page = t.deposits_from(0, 10);
        assert_eq!(page.len(), 3);
        assert_eq!(page[0].index, 0);
        assert_eq!(page[0].sender, acc("alice.testnet"));
        assert_eq!(page[0].amount, U128(5_000_000));
        assert_eq!(page[0].block_height, 42);
        assert_eq!(page[0].timestamp_ms, 1_700_000_000_000);
        assert_eq!(page[2].index, 2);
        assert_eq!(t.total_deposited(acc("alice.testnet")), U128(7_000_000));
        assert_eq!(t.total_deposited(acc("carol.testnet")), U128(0));
    }

    #[test]
    fn cursor_pagination() {
        let mut t = setup();
        for _ in 0..5 {
            t.ft_on_transfer(acc("alice.testnet"), U128(1), String::new());
        }
        assert_eq!(t.deposits_from(3, 10).iter().map(|d| d.index).collect::<Vec<_>>(), vec![3, 4]);
        assert!(t.deposits_from(5, 10).is_empty());
        assert!(t.deposits_from(99, 10).is_empty());
        assert_eq!(t.deposits_from(0, 2).len(), 2);
    }

    #[test]
    fn page_size_is_capped() {
        let mut t = setup();
        for _ in 0..(MAX_PAGE + 5) {
            ctx(USDC); // her cagri ayri islem — log siniri islem basina
            t.ft_on_transfer(acc("alice.testnet"), U128(1), String::new());
        }
        assert_eq!(t.deposits_from(0, 1_000).len() as u64, MAX_PAGE);
    }

    #[test]
    fn emits_nep297_event() {
        let mut t = setup();
        t.ft_on_transfer(acc("alice.testnet"), U128(7), String::new());
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("EVENT_JSON:"));
        assert!(logs[0].contains(r#""event":"deposit""#));
        assert!(logs[0].contains(r#""sender":"alice.testnet""#));
    }

    #[test]
    #[should_panic(expected = "only USDC is accepted")]
    fn rejects_other_tokens() {
        let mut t = setup();
        ctx("fake-usdc.testnet");
        t.ft_on_transfer(acc("alice.testnet"), U128(5), String::new());
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn rejects_zero() {
        let mut t = setup();
        t.ft_on_transfer(acc("alice.testnet"), U128(0), String::new());
    }

    #[test]
    #[should_panic(expected = "only the treasury account can initialize")]
    fn only_self_can_init() {
        ctx("mallory.testnet");
        Treasury::new(acc(USDC));
    }
}
