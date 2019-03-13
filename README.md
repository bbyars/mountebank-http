# An example mountebank protocol implementation

[Mountebank](http://mbtest.org/docs/protocols/custom) allows you to create custom
protocol implementations. This example demonstrates a custom HTTP implementation.
Even though mountebank ships with a built-in HTTP server, it makes a useful example
simply because HTTP is the most commonly understood network protocol.

To run the example, download the source locally. Create a file called "protocols.json"
with the following content (replace PATH with the downloaded path):

````
{
  "http": {
    "createCommand": "node PATH/mountebank-http/src/index.js"
  }
}
````


