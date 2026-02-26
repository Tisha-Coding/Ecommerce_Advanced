// import { currency } from "../../admin/src/App.jsx";
import orderModel from "../models/orderModel.js";
import userModel from "../models/userModel.js";
import Stripe from "stripe";
import razorpay from "razorpay";

// global variables
const currency = "INR";
const deliveryCharge = 10;

//  gateway initialize
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const razorpayInstance = new razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Map UI status to orderStatus enum
const statusToOrderStatus = (status) => {
  const s = (status || "").trim();
  if (s === "Delivered" || s === "Cancelled") return s;
  if (s === "Shipped" || s === "Out for delivery") return "Shipped";
  return "Processing";
};

// Allowed transitions only forward; Delivered/Cancelled = final (no backward update)
const ALLOWED_TRANSITIONS = {
  Processing: ["Shipped", "Cancelled"],
  Shipped: ["Delivered", "Cancelled"],
  Delivered: [],   // final - cannot change back
  Cancelled: [],   // final - cannot change back
};

const isValidStatusTransition = (currentOrderStatus, nextOrderStatus) => {
  const allowed = ALLOWED_TRANSITIONS[currentOrderStatus];
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(nextOrderStatus);
};

// Placing orders using COD Method
const placeOrder = async (req, res) => {
  try {
    const { userId, items, amount, address } = req.body;
    const deliveryPhone = address?.phone || "";
    const orderData = {
      userId,
      items,
      address,
      deliveryPhone,
      amount,
      paymentMethod: "COD",
      payment: false,
      paymentStatus: "Pending",
      orderStatus: "Processing",
      status: "Order Placed",
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();

    // Clear the cart data because we have already placed the order above
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    res.json({ success: true, message: "Order Placed" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Placing orders using Stripe Method

const placeOrderStripe = async (req, res) => {
  try {
    const { userId, items, amount, address } = req.body;
    const { origin } = req.headers;
    const finalAmount = await applySubscriberDiscount(address, amount);
    const discountRatio = finalAmount / amount;
    // Extract phone from address for delivery (separate from user profile phone)
    const deliveryPhone = address?.phone || "";

    const orderData = {
      userId,
      items,
      address,
      deliveryPhone,
      amount: finalAmount,
      paymentMethod: "Stripe",
      payment: false,
      paymentStatus: "Pending",
      orderStatus: "Processing",
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();

    const line_items = items.map((item) => ({
      price_data: {
        currency: currency,
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100,
      },
      quantity: item.quantity,
    }));

    line_items.push({
      price_data: {
        currency: currency,
        product_data: {
          name: "Delivery Charges",
        },
        unit_amount: deliveryCharge * 100,
      },
      quantity: 1,
    });

    // create new session

    const session = await stripe.checkout.sessions.create({
      success_url: `${origin}/verify?success=true&orderId=${newOrder._id}`,
      cancel_url: `${origin}/verify?success=false&orderId=${newOrder._id}`,
      line_items,
      mode: "payment",
    });

    res.json({ success: true, session_url: session.url });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Verify Stripe
const verifyStripe = async (req, res) => {
  const { orderId, success, userId } = req.body;

  try {
    if (success === "true") {
      await orderModel.findByIdAndUpdate(orderId, {
        payment: true,
        paymentStatus: "Completed",
      });
      await userModel.findByIdAndUpdate(userId, { cartData: {} });
      res.json({ success: true });
    } else {
      await orderModel.findByIdAndDelete(orderId);
      res.json({ success: false });
    }
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Placing orders using Razorpay Method

const placeOrderRazorpay = async (req, res) => {
  try {
    const { userId, items, amount, address } = req.body;
    const finalAmount = await applySubscriberDiscount(address, amount);
    // Extract phone from address for delivery (separate from user profile phone)
    const deliveryPhone = address?.phone || "";

    const orderData = {
      userId,
      items,
      address,
      deliveryPhone,
      amount: finalAmount,
      paymentMethod: "Razorpay",
      payment: false,
      paymentStatus: "Pending",
      orderStatus: "Processing",
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();

    const options = {
      amount: amount * 100,
      currency: currency.toUpperCase(),
      receipt: newOrder._id.toString(),
    };

    await razorpayInstance.orders.create(options, (error, order) => {
      if (error) {
        console.log(error);
        return res.json({ success: false, message: error });
      }
      res.json({ success: true, order });
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

const verifyRazorpay = async (req, res) => {
  try {
    const { userId, razorpay_order_id } = req.body;

    const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id);
    if (orderInfo.status === "paid") {
      await orderModel.findByIdAndUpdate(orderInfo.receipt, {
        payment: true,
        paymentStatus: "Completed",
      });
      await userModel.findByIdAndUpdate(userId, { cartData: {} });
      res.json({ success: true, message: "Payment Successful" });
    } else {
      res.json({ success: false, message: "Payment failed" });
    }
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Normalize order for API response (backfill orderStatus/paymentStatus for old orders)
const normalizeOrder = (order) => {
  const o = order.toObject ? order.toObject() : { ...order };
  if (!o.orderStatus) o.orderStatus = statusToOrderStatus(o.status);
  if (!o.paymentStatus) o.paymentStatus = o.payment ? "Completed" : "Pending";
  return o;
};

// All orders data for Admin Panel
const allOrders = async (req, res) => {
  try {
    const orders = await orderModel.find({});
    res.json({ success: true, orders: orders.map(normalizeOrder) });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// User Order Data For Frontend
const userOrders = async (req, res) => {
  try {
    const { userId } = req.body;
    const orders = await orderModel.find({ userId });
    res.json({ success: true, orders: orders.map(normalizeOrder) });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Update order status from Admin Panel (no backward update from Delivered/Cancelled)
const updateStatus = async (req, res) => {
  try {
    const { orderId, status } = req.body;
    const order = await orderModel.findById(orderId);
    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Something went wrong. Please try again.",
      });
    }

    const currentOrderStatus =
      order.orderStatus || statusToOrderStatus(order.status);
    const nextOrderStatus = statusToOrderStatus(status);

    // Block backward / invalid transitions (e.g. Delivered → Shipped)
    if (!isValidStatusTransition(currentOrderStatus, nextOrderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status transition.",
      });
    }

    const update = {
      status,
      orderStatus: nextOrderStatus,
    };

    // When admin sets order to Delivered and payment is COD, mark payment as Completed
    if (
      nextOrderStatus === "Delivered" &&
      (order.paymentMethod || "").toUpperCase() === "COD"
    ) {
      update.paymentStatus = "Completed";
      update.payment = true;
    }

    await orderModel.findByIdAndUpdate(orderId, { $set: update });
    return res.json({ success: true, message: "Status Updated" });
  } catch (error) {
    console.log(error);
    return res.json({ success: false, message: error.message });
  }
};

export {
  verifyRazorpay,
  verifyStripe,
  placeOrder,
  placeOrderStripe,
  placeOrderRazorpay,
  allOrders,
  userOrders,
  updateStatus,
};
