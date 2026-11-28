mod greet;
mod use_it;

pub use greet::Hello;

pub fn call() -> String {
    use_it::call()
}
